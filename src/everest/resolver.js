'use strict';

/**
 * Resolver — merges five layers into effective specs with provenance tracking.
 *
 * Layer priority (lowest → highest):
 *   basecamp defaults → archetype → stack → ecosystem → service → profile
 *
 * Provenance sources:
 *   'basecamp' | 'archetype:<name>' | 'stack:<name>' | 'ecosystem' | 'service' | 'profile:<name>' | 'derived:<rule>'
 */

/**
 * @typedef {object} Resolved
 * @property {object} services   Map of serviceId → effective spec with provenance
 * @property {object} topology   { nodes, edges }
 * @property {object} consumers  Map of topic/command → list of consumers
 */

/**
 * Resolve all services in an ecosystem.
 * @param {{ basecamp, rules, archetypes, stacks }} bc  Loaded basecamp
 * @param {{ meta, contracts, services }}           eco Loaded ecosystem
 * @param {{ profile?: string }}                    opts
 * @returns {Resolved}
 */
function resolve(bc, eco, opts = {}) {
  const profile = opts.profile || null;

  const resolvedServices = {};
  for (const [id, svc] of Object.entries(eco.services)) {
    resolvedServices[id] = resolveService(bc, eco, svc, profile);
  }

  const topology = buildTopology(resolvedServices, eco);
  const consumers = buildConsumers(resolvedServices);

  return { services: resolvedServices, topology, consumers };
}

function resolveService(bc, eco, svc, profile) {
  const archetypeName = svc.archetype;
  const archetype = bc.archetypes[archetypeName];
  const stackName = svc.stack || bc.basecamp.defaults.stack;
  const stack = bc.stacks[stackName];

  // Build effective spec layer by layer with provenance
  const layers = [
    { source: 'basecamp', data: flattenDefaults(bc.basecamp.defaults) },
    { source: `archetype:${archetypeName}`, data: archetypeDefaults(archetype) },
    { source: `stack:${stackName}`, data: stackDefaults(stack) },
    { source: 'ecosystem', data: ecoOverrides(eco.meta, svc) },
    { source: 'service', data: serviceData(svc) },
  ];

  if (profile && eco.meta.profiles && eco.meta.profiles[profile]) {
    layers.push({ source: `profile:${profile}`, data: eco.meta.profiles[profile] });
  }

  const effective = mergeLayers(layers);

  // Apply derived rules
  applyDerivedRules(effective, svc, bc.rules);

  return effective;
}

// ─── Layer extractors ─────────────────────────────────────────────────────────

function flattenDefaults(defaults) {
  return {
    _stack: defaults.stack,
    runtime: { ...defaults.runtime },
    deploy: { ...defaults.deploy },
    messaging: { ...defaults.messaging },
    _persistenceEngines: { ...defaults.persistence },
  };
}

function archetypeDefaults(archetype) {
  if (!archetype) return {};
  return {
    _communication: archetype.communication,
    _persistenceAllowed: archetype.persistence?.allowed,
    _persistenceDefault: archetype.persistence?.default,
    _requires: archetype.requires,
    _naming: archetype.naming,
  };
}

function stackDefaults(stack) {
  if (!stack) return {};
  return {
    runtime: stack.runtime ? { ...stack.runtime } : undefined,
  };
}

function ecoOverrides(meta, svc) {
  // Nothing from ecosystem level overrides individual services in v1
  return {};
}

function serviceData(svc) {
  const data = {};
  const passThrough = ['service', 'archetype', 'domain', 'purpose', 'stack',
    'api', 'calls', 'publishes', 'consumes', 'sends', 'accepts',
    'stores', 'schedule', 'foreign', 'env', 'deviations'];
  for (const key of passThrough) {
    if (svc[key] !== undefined) data[key] = svc[key];
  }
  return data;
}

// ─── Merge engine ─────────────────────────────────────────────────────────────

/**
 * Merge layers into a single effective spec with provenance metadata.
 * Returns { values: {}, _provenance: { key → source } }
 */
function mergeLayers(layers) {
  const values = {};
  const provenance = {};

  for (const { source, data } of layers) {
    if (!data) continue;
    mergeInto(values, provenance, data, source, '');
  }

  return { ...values, _provenance: provenance };
}

function mergeInto(target, provenance, src, source, prefix) {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    const fullKey = prefix ? `${prefix}.${k}` : k;

    // null removes inherited entry
    if (v === null) {
      delete target[k];
      provenance[fullKey] = `${source} (removed)`;
      continue;
    }

    // key+: [...] appends to inherited list
    if (k.endsWith('+') && Array.isArray(v)) {
      const baseKey = k.slice(0, -1);
      if (Array.isArray(target[baseKey])) {
        target[baseKey] = [...target[baseKey], ...v];
      } else {
        target[baseKey] = [...v];
      }
      provenance[prefix ? `${prefix}.${baseKey}` : baseKey] = source;
      continue;
    }

    // If both sides are plain objects (not arrays), merge recursively
    if (isPlainObject(v) && isPlainObject(target[k])) {
      mergeInto(target[k], provenance, v, source, fullKey);
    } else {
      target[k] = v;
      provenance[fullKey] = source;
    }
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ─── Derived rules ────────────────────────────────────────────────────────────

function applyDerivedRules(effective, svc, rules) {
  // PERS-003: service that writes a store and publishes events → consistency: outbox
  if (svc.stores && Object.keys(svc.stores).length > 0 && svc.publishes && svc.publishes.length > 0) {
    // Check if any store is writable (not read-only)
    const hasWriteStore = Object.values(svc.stores).some(s =>
      s.pattern !== 'read-only'
    );
    if (hasWriteStore) {
      if (!effective.consistency) {
        effective.consistency = 'outbox';
        effective._provenance['consistency'] = 'derived:PERS-003';
      }
    }
  }
}

// ─── Topology builder ─────────────────────────────────────────────────────────

function buildTopology(resolvedServices, eco) {
  const nodes = [];
  const edges = [];

  for (const [id, eff] of Object.entries(resolvedServices)) {
    nodes.push({
      id,
      archetype: eff.archetype,
      domain: eff.domain,
      purpose: eff.purpose,
      stack: eff.stack || eff._stack,
    });
  }

  for (const [id, eff] of Object.entries(resolvedServices)) {
    // REST/gRPC calls
    if (eff.calls) {
      for (const [target, callDef] of Object.entries(eff.calls)) {
        const srcDomain = eff.domain;
        const tgtEff = resolvedServices[target];
        const tgtDomain = tgtEff?.domain;
        const crossDomain = srcDomain && tgtDomain && srcDomain !== tgtDomain;
        const hasDeviation = eff.deviations?.['ARCH-010'] != null;
        edges.push({
          from: id,
          to: target,
          mode: callDef.via || 'rest',
          crossDomain,
          deviation: crossDomain && !isGateway(eff) ? (hasDeviation ? 'accepted' : 'violation') : null,
        });
      }
    }

    // Event publishes
    if (eff.publishes) {
      for (const topic of eff.publishes) {
        // Find all consumers
        for (const [cid, ceff] of Object.entries(resolvedServices)) {
          if (ceff.consumes && ceff.consumes[topic]) {
            edges.push({ from: id, to: cid, mode: 'event', topic });
          }
        }
      }
    }

    // Commands sent
    if (eff.sends) {
      for (const [cmdName, sendDef] of Object.entries(eff.sends)) {
        edges.push({ from: id, to: sendDef.to, mode: 'command', command: cmdName });
      }
    }
  }

  return { nodes, edges };
}

function isGateway(eff) {
  return eff.archetype === 'gateway';
}

// ─── Consumer index ───────────────────────────────────────────────────────────

function buildConsumers(resolvedServices) {
  const consumers = {};
  for (const [id, eff] of Object.entries(resolvedServices)) {
    if (eff.consumes) {
      for (const [topic, def] of Object.entries(eff.consumes)) {
        if (!consumers[topic]) consumers[topic] = [];
        consumers[topic].push({ service: id, handler: def.handler });
      }
    }
    if (eff.accepts) {
      for (const [cmd, def] of Object.entries(eff.accepts)) {
        if (!consumers[cmd]) consumers[cmd] = [];
        consumers[cmd].push({ service: id, handler: def.handler });
      }
    }
  }
  return consumers;
}

module.exports = { resolve };
