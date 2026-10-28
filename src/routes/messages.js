'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const YAML = require('yaml');
const { User } = require('../db');
const { readEcosystemFiles, loadAndResolve, applyPatches } = require('../gitStore');
const { renderViolations } = require('../everest');

const router = express.Router({ mergeParams: true });

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(bc, eco, violations, ecoFiles) {
  const archetypes = bc.archetypes;
  const rules = bc.rules;

  const archetypeText = Object.entries(archetypes)
    .map(([name, arch]) => {
      const inbound = arch.communication?.inbound?.join(', ') || 'none';
      const outbound = arch.communication?.outbound?.join(', ') || 'none';
      const must = (arch.responsibilities?.must || []).map(r => `  - ${r}`).join('\n');
      const mustNot = (arch.responsibilities?.mustNot || []).map(r => `  - ${r}`).join('\n');
      return `### ${name}\n${arch.summary}\nInbound: ${inbound}\nOutbound: ${outbound}\nMust:\n${must}\nMust not:\n${mustNot}`;
    }).join('\n\n');

  const rulesText = Object.entries(rules)
    .map(([id, r]) => `- **${id}** (${r.enforcement}): ${r.description}`)
    .join('\n');

  const servicesText = Object.entries(eco.services)
    .map(([id, svc]) => {
      const short = YAML.stringify({ service: id, archetype: svc.archetype, domain: svc.domain, purpose: svc.purpose });
      return short.trim();
    }).join('\n---\n');

  const violationText = violations.length > 0
    ? `\nCurrent violations:\n${renderViolations(violations)}`
    : '\nNo current violations.';

  const allFiles = Object.entries(ecoFiles)
    .map(([p, c]) => `--- ${p}\n${c}`)
    .join('\n\n');

  return `You are Everest, an expert software architect helping design systems using the Everest architecture language.

Your role: Work with the user to design and refine a distributed system expressed as Everest specs.

## Architecture principles
- Services own their data exclusively (no shared stores)
- Communication is event-driven by default; synchronous calls are the exception
- Every boundary is explicit: REST, gRPC, events, commands, foreign APIs
- Archetypes constrain what a service can do; deviations are allowed with a reason

## Archetypes
${archetypeText}

## Rules
${rulesText}

## Current ecosystem: ${eco.meta.ecosystem}
${eco.meta.description || ''}

Domains: ${Object.entries(eco.meta.domains || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none defined'}

### Services
${servicesText || 'No services yet.'}

### All authored files
${allFiles}
${violationText}

## How to respond
- Discuss architecture with the user before formalizing.
- When the user confirms a design decision, emit changes using ONLY these blocks:

<everest_patch path="services/order-service.yaml">
...complete file content...
</everest_patch>

<everest_patch path="services/old-service.yaml" delete="true"/>

- Paths are limited to: ecosystem.yaml, contracts/events.yaml, contracts/commands.yaml, contracts/types.yaml, services/<id>.yaml
- ALWAYS emit complete file content (not diffs) inside patch blocks.
- **ecosystem.yaml schema** — `domains` MUST be a flat map of name → description string. Never nest objects under a domain key. Example:
  ```yaml
  meta:
    ecosystem: my-system
    description: "What this system does"
    domains:
      catalog: "Product catalog and search"
      ordering: "Cart and order lifecycle"
  ```
- If a change would violate a locked rule, discuss it and propose a deviation with a reason — ask the user for the reason if you don't have one.
- If a change violates a default rule, add a deviations entry with the user's reason rather than silently breaking it.
- Do NOT generate code, Dockerfiles, CLAUDE.md, Helm charts, or spec.md. Only Everest spec files.`;
}

// ─── Patch parser ─────────────────────────────────────────────────────────────

function parsePatches(text) {
  const patches = [];
  // Match <everest_patch path="..." delete="true"/> (self-closing delete)
  const deleteRe = /<everest_patch\s+path="([^"]+)"\s+delete="true"\s*\/>/g;
  let m;
  while ((m = deleteRe.exec(text)) !== null) {
    patches.push({ path: m[1], content: null });
  }
  // Match <everest_patch path="...">...</everest_patch>
  const patchRe = /<everest_patch\s+path="([^"]+)">([\s\S]*?)<\/everest_patch>/g;
  while ((m = patchRe.exec(text)) !== null) {
    patches.push({ path: m[1], content: m[2].trim() });
  }
  return patches;
}

function stripPatches(text) {
  return text
    .replace(/<everest_patch\s+path="[^"]+"\s+delete="true"\s*\/>/g, '')
    .replace(/<everest_patch\s+path="[^"]+">([\s\S]*?)<\/everest_patch>/g, '')
    .trim();
}

// ─── POST /api/ecosystems/:name/messages ─────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { name } = req.params;
    const userId = req.auth.payload.sub;
    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }

    // Fetch user API key
    const user = await User.findOne({ userId });
    if (!user?.anthropicApiKey) {
      return res.status(400).json({ error: 'No Anthropic API key configured. Set it via PUT /api/user/profile.' });
    }

    // Load ecosystem state
    const ecoFiles = await readEcosystemFiles(name);
    const { bc, eco, violations } = await loadAndResolve(name).catch(err => {
      throw new Error(`Ecosystem load error: ${err.message}`);
    });

    const systemPrompt = buildSystemPrompt(bc, eco, violations, ecoFiles);

    // Call Anthropic
    const client = new Anthropic({ apiKey: user.anthropicApiKey });
    const response = await client.messages.create({
      model: user.anthropicModel || 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    });

    const rawContent = response.content[0]?.text || '';
    const patches = parsePatches(rawContent);
    const content = stripPatches(rawContent);

    let commit = null;
    let errors = [];
    let newViolations = violations;

    // Apply patches if any
    if (patches.length > 0) {
      const userPrompt = messages[messages.length - 1]?.content || '';
      const a = {
        name: req.auth.payload.name || req.auth.payload.preferred_username || userId,
        email: req.auth.payload.email || `${userId}@everest`,
      };

      // Extract one-line summary from assistant response
      const summary = content.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 80)
        || `Update via chat`;

      const result = await applyPatches(name, patches, a, summary, userPrompt.slice(0, 200));

      if (result.errors?.length) {
        errors = result.errors;
      } else {
        commit = { sha: result.sha, summary: result.summary, files: result.files };
        newViolations = result.violations;
      }
    }

    res.json({ content, commit, errors, violations: newViolations });
  } catch (e) {
    console.error('messages error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
