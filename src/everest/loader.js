'use strict';

const YAML = require('yaml');
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

// ─── JSON Schemas ────────────────────────────────────────────────────────────

const basecampSchema = {
  type: 'object',
  required: ['basecamp', 'version', 'defaults', 'stacks'],
  properties: {
    basecamp: { type: 'string' },
    version: { type: 'string' },
    defaults: {
      type: 'object',
      required: ['stack', 'runtime', 'deploy', 'messaging', 'persistence'],
      properties: {
        stack: { type: 'string' },
        runtime: {
          type: 'object',
          required: ['port', 'health'],
          properties: { port: { type: 'integer' }, health: { type: 'string' } },
        },
        deploy: {
          type: 'object',
          required: ['namespace', 'registry'],
          properties: {
            namespace: { type: 'string' },
            registry: { type: 'string' },
            pullPolicy: { type: 'string' },
          },
        },
        messaging: {
          type: 'object',
          properties: {
            broker: { type: 'string' },
            serialization: { type: 'string' },
            delivery: { type: 'string' },
            dlq: { type: 'boolean' },
          },
        },
        persistence: { type: 'object' },
      },
    },
    stacks: { type: 'array', items: { type: 'string' } },
  },
};

const rulesSchema = {
  type: 'object',
  required: ['rules'],
  properties: {
    rules: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['description', 'enforcement'],
        properties: {
          description: { type: 'string' },
          enforcement: { enum: ['locked', 'default', 'advisory'] },
          autoFixable: { type: 'boolean' },
        },
      },
    },
  },
};

const archetypeSchema = {
  type: 'object',
  required: ['archetype', 'version', 'summary', 'responsibilities', 'communication', 'persistence'],
  properties: {
    archetype: { type: 'string' },
    version: { type: 'string' },
    summary: { type: 'string' },
    naming: {
      type: 'object',
      properties: {
        idSuffix: { type: 'string' },
        nameSuffix: { type: 'string' },
      },
    },
    responsibilities: {
      type: 'object',
      properties: {
        must: { type: 'array', items: { type: 'string' } },
        mustNot: { type: 'array', items: { type: 'string' } },
      },
    },
    communication: {
      type: 'object',
      properties: {
        inbound: { type: 'array', items: { type: 'string' } },
        outbound: { type: 'array', items: { type: 'string' } },
      },
    },
    persistence: {
      type: 'object',
      properties: {
        allowed: { type: 'array', items: { type: 'string' } },
        default: { type: ['string', 'null'] },
      },
    },
    requires: { type: 'array', items: { type: 'string' } },
    rules: { type: 'array', items: { type: 'string' } },
  },
};

const ecosystemSchema = {
  type: 'object',
  required: ['ecosystem', 'extends'],
  properties: {
    ecosystem: { type: 'string' },
    extends: { type: 'string' },
    description: { type: 'string' },
    domains: { type: 'object', additionalProperties: { type: 'string' } },
    profiles: { type: 'object' },
  },
};

const serviceSchema = {
  type: 'object',
  required: ['service', 'archetype'],
  properties: {
    service: { type: 'string' },
    archetype: { type: 'string' },
    domain: { type: 'string' },
    purpose: { type: 'string' },
    stack: { type: 'string' },
    api: { type: 'object' },
    calls: { type: 'object' },
    publishes: { type: 'array', items: { type: 'string' } },
    consumes: { type: 'object' },
    sends: { type: 'object' },
    accepts: { type: 'object' },
    stores: { type: 'object' },
    schedule: { type: 'string' },
    foreign: { type: 'object' },
    env: { type: 'object' },
    deviations: { type: 'object' },
  },
};

const validateBasecamp = ajv.compile(basecampSchema);
const validateRules = ajv.compile(rulesSchema);
const validateArchetype = ajv.compile(archetypeSchema);
const validateEcosystem = ajv.compile(ecosystemSchema);
const validateService = ajv.compile(serviceSchema);

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseYaml(content, path) {
  try {
    return YAML.parse(content);
  } catch (e) {
    throw new Error(`${path}: YAML parse error: ${e.message}`);
  }
}

function validateSchema(data, validator, path) {
  if (!validator(data)) {
    const msgs = validator.errors.map(e => `  ${e.instancePath || '/'} ${e.message}`).join('\n');
    throw new Error(`${path}: schema validation failed:\n${msgs}`);
  }
}

/**
 * Load a basecamp from a map of { filename → content } strings.
 * Expected files: basecamp.yaml, rules.yaml, archetypes/*.yaml, stacks/*.yaml
 * @param {Map<string,string>} files
 * @returns {{ basecamp, rules, archetypes, stacks }}
 */
function loadBasecamp(files) {
  const get = (key) => {
    const v = files instanceof Map ? files.get(key) : files[key];
    return v;
  };

  // basecamp.yaml
  const basecampRaw = get('basecamp.yaml');
  if (!basecampRaw) throw new Error('basecamp: missing basecamp.yaml');
  const basecamp = parseYaml(basecampRaw, 'basecamp.yaml');
  validateSchema(basecamp, validateBasecamp, 'basecamp.yaml');

  // rules.yaml
  const rulesRaw = get('rules.yaml');
  if (!rulesRaw) throw new Error('basecamp: missing rules.yaml');
  const rulesDoc = parseYaml(rulesRaw, 'rules.yaml');
  validateSchema(rulesDoc, validateRules, 'rules.yaml');
  const rules = rulesDoc.rules;

  // archetypes
  const archetypes = {};
  for (const [path, content] of entries(files)) {
    if (!path.startsWith('archetypes/') || !path.endsWith('.yaml')) continue;
    const doc = parseYaml(content, path);
    validateSchema(doc, validateArchetype, path);
    archetypes[doc.archetype] = doc;
  }

  // stacks
  const stacks = {};
  for (const [path, content] of entries(files)) {
    if (!path.startsWith('stacks/') || !path.endsWith('.yaml')) continue;
    const doc = parseYaml(content, path);
    stacks[doc.stack] = doc;
  }

  return { basecamp, rules, archetypes, stacks };
}

/**
 * Load an ecosystem from a map of { filename → content } strings.
 * Expected files: ecosystem.yaml, contracts/events.yaml, contracts/commands.yaml,
 *                 contracts/types.yaml, services/*.yaml
 * @param {Map<string,string>|object} files
 * @returns {{ meta, contracts, services }}
 */
function loadEcosystem(files) {
  // ecosystem.yaml
  const ecosystemRaw = getFile(files, 'ecosystem.yaml');
  if (!ecosystemRaw) throw new Error('ecosystem: missing ecosystem.yaml');
  const meta = parseYaml(ecosystemRaw, 'ecosystem.yaml');
  validateSchema(meta, validateEcosystem, 'ecosystem.yaml');

  // contracts
  const contracts = {
    events: {},
    commands: {},
    types: {},
  };
  const eventsRaw = getFile(files, 'contracts/events.yaml');
  if (eventsRaw) contracts.events = parseYaml(eventsRaw, 'contracts/events.yaml') || {};
  const commandsRaw = getFile(files, 'contracts/commands.yaml');
  if (commandsRaw) contracts.commands = parseYaml(commandsRaw, 'contracts/commands.yaml') || {};
  const typesRaw = getFile(files, 'contracts/types.yaml');
  if (typesRaw) contracts.types = parseYaml(typesRaw, 'contracts/types.yaml') || {};

  // services
  const services = {};
  for (const [path, content] of entries(files)) {
    if (!path.startsWith('services/') || !path.endsWith('.yaml')) continue;
    const doc = parseYaml(content, path);
    validateSchema(doc, validateService, path);
    services[doc.service] = doc;
  }

  return { meta, contracts, services };
}

function getFile(files, key) {
  if (files instanceof Map) return files.get(key);
  return files[key];
}

function entries(files) {
  if (files instanceof Map) return files.entries();
  return Object.entries(files);
}

module.exports = { loadBasecamp, loadEcosystem };
