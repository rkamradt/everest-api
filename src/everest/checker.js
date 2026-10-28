'use strict';

/**
 * Rule checker — runs all rules against a resolved ecosystem.
 *
 * @param {{ basecamp, rules, archetypes, stacks }} bc
 * @param {{ meta, contracts, services }} eco
 * @param {object} resolved  Output from resolver.resolve()
 * @returns {Violation[]}
 */

/**
 * @typedef {object} Violation
 * @property {string} ruleId
 * @property {'locked'|'default'|'advisory'} level
 * @property {'error'|'warning'} severity
 * @property {string} service
 * @property {string} path
 * @property {string} message
 * @property {object|null} deviation  { reason, scope } if accepted
 */

function check(bc, eco, resolved) {
  const violations = [];

  // Collect all rule checkers
  const checkers = [
    checkARCH001,
    checkARCH010,
    checkARCH020,
    checkEVT001,
    checkEVT002,
    checkCMD001,
    checkCMD002,
    checkPERS003,
    checkNAME001,
    checkDEP001,
    checkCOMM001,
    checkREF001,
  ];

  for (const checker of checkers) {
    violations.push(...checker(bc, eco, resolved));
  }

  return violations;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeViolation(ruleId, bc, service, path, message, eco) {
  const level = bc.rules[ruleId]?.enforcement || 'default';
  const deviation = eco.services[service]?.deviations?.[ruleId] || null;
  const severity = (level === 'locked') ? 'error'
    : (level === 'advisory') ? 'warning'
    : (deviation ? 'warning' : 'error');
  return { ruleId, level, severity, service, path, message, deviation };
}

// ─── ARCH-001: No store owned by more than one service ─────────────────────

function checkARCH001(bc, eco, resolved) {
  const violations = [];
  const storeOwners = {};

  for (const [id, svc] of Object.entries(eco.services)) {
    if (!svc.stores) continue;
    for (const storeName of Object.keys(svc.stores)) {
      if (storeOwners[storeName]) {
        violations.push(makeViolation('ARCH-001', bc, id, `stores.${storeName}`,
          `Store '${storeName}' is already owned by '${storeOwners[storeName]}'`, eco));
      } else {
        storeOwners[storeName] = id;
      }
    }
  }
  return violations;
}

// ─── ARCH-010: Cross-domain sync calls must be async (gateway exempt) ───────

function checkARCH010(bc, eco, resolved) {
  const violations = [];

  for (const [id, svc] of Object.entries(eco.services)) {
    if (svc.archetype === 'gateway') continue;
    if (!svc.calls) continue;
    const srcDomain = svc.domain;

    for (const [target, callDef] of Object.entries(svc.calls)) {
      const tgtSvc = eco.services[target];
      if (!tgtSvc) continue;
      const tgtDomain = tgtSvc.domain;
      if (srcDomain && tgtDomain && srcDomain !== tgtDomain) {
        violations.push(makeViolation('ARCH-010', bc, id, `calls.${target}`,
          `Synchronous call to '${target}' crosses domain boundary (${srcDomain} → ${tgtDomain}). Use events or commands instead, or add a deviation with a reason.`,
          eco));
      }
    }
  }
  return violations;
}

// ─── ARCH-020: provider/adaptor have no domain stores ───────────────────────

function checkARCH020(bc, eco, resolved) {
  const violations = [];
  const restricted = new Set(['provider', 'adaptor']);
  const domainKinds = new Set(['relational', 'document', 'blob', 'search']);

  for (const [id, svc] of Object.entries(eco.services)) {
    if (!restricted.has(svc.archetype)) continue;
    if (!svc.stores) continue;
    for (const [name, store] of Object.entries(svc.stores)) {
      if (domainKinds.has(store.kind)) {
        violations.push(makeViolation('ARCH-020', bc, id, `stores.${name}`,
          `${svc.archetype} services may only have kv or cache stores; '${name}' is kind '${store.kind}'`,
          eco));
      }
    }
  }
  return violations;
}

// ─── EVT-001: Each event has exactly one producer matching catalog owner ─────

function checkEVT001(bc, eco, resolved) {
  const violations = [];
  const events = eco.contracts?.events || {};

  // For each cataloged event, find all publishers
  const publishers = {};
  for (const [id, svc] of Object.entries(eco.services)) {
    for (const topic of (svc.publishes || [])) {
      if (!publishers[topic]) publishers[topic] = [];
      publishers[topic].push(id);
    }
  }

  for (const [topic, def] of Object.entries(events)) {
    const pubs = publishers[topic] || [];
    if (pubs.length === 0) {
      // No publisher — flag on 'ecosystem' level
      violations.push({ ruleId: 'EVT-001', level: 'locked', severity: 'error',
        service: '_ecosystem', path: `contracts.events.${topic}`,
        message: `Event '${topic}' is in the catalog (owner: ${def.owner}) but no service publishes it`, deviation: null });
    } else if (pubs.length > 1) {
      for (const pub of pubs) {
        violations.push(makeViolation('EVT-001', bc, pub, `publishes`,
          `Event '${topic}' is published by multiple services: ${pubs.join(', ')}`, eco));
      }
    } else if (pubs[0] !== def.owner) {
      violations.push(makeViolation('EVT-001', bc, pubs[0], `publishes`,
        `Event '${topic}' is published by '${pubs[0]}' but the catalog declares owner '${def.owner}'`, eco));
    }
  }

  // Events published but not in catalog
  for (const [id, svc] of Object.entries(eco.services)) {
    for (const topic of (svc.publishes || [])) {
      if (!events[topic]) {
        violations.push({ ruleId: 'EVT-001', level: 'locked', severity: 'error',
          service: id, path: `publishes`,
          message: `Service '${id}' publishes event '${topic}' which is not in the catalog`, deviation: null });
      }
    }
  }

  return violations;
}

// ─── EVT-002: Every consumed event exists in the catalog ─────────────────────

function checkEVT002(bc, eco, resolved) {
  const violations = [];
  const events = eco.contracts?.events || {};

  for (const [id, svc] of Object.entries(eco.services)) {
    if (!svc.consumes) continue;
    for (const topic of Object.keys(svc.consumes)) {
      if (!events[topic]) {
        violations.push(makeViolation('EVT-002', bc, id, `consumes.${topic}`,
          `Consumed event '${topic}' is not in the catalog`, eco));
      }
    }
  }
  return violations;
}

// ─── CMD-001: Each command has exactly one receiver ──────────────────────────

function checkCMD001(bc, eco, resolved) {
  const violations = [];
  const commands = eco.contracts?.commands || {};

  const receivers = {};
  for (const [id, svc] of Object.entries(eco.services)) {
    if (!svc.accepts) continue;
    for (const cmd of Object.keys(svc.accepts)) {
      if (!receivers[cmd]) receivers[cmd] = [];
      receivers[cmd].push(id);
    }
  }

  for (const [cmd, def] of Object.entries(commands)) {
    const rcvs = receivers[cmd] || [];
    if (rcvs.length === 0) {
      violations.push({ ruleId: 'CMD-001', level: 'locked', severity: 'error',
        service: '_ecosystem', path: `contracts.commands.${cmd}`,
        message: `Command '${cmd}' is in the catalog (receiver: ${def.receiver}) but no service accepts it`, deviation: null });
    } else if (rcvs.length > 1) {
      for (const rcv of rcvs) {
        violations.push(makeViolation('CMD-001', bc, rcv, `accepts`,
          `Command '${cmd}' is accepted by multiple services: ${rcvs.join(', ')}`, eco));
      }
    } else if (rcvs[0] !== def.receiver) {
      violations.push(makeViolation('CMD-001', bc, rcvs[0], `accepts`,
          `Command '${cmd}' accepted by '${rcvs[0]}' but catalog declares receiver '${def.receiver}'`, eco));
    }
  }

  // Commands accepted but not in catalog
  for (const [id, svc] of Object.entries(eco.services)) {
    if (!svc.accepts) continue;
    for (const cmd of Object.keys(svc.accepts)) {
      if (!commands[cmd]) {
        violations.push({ ruleId: 'CMD-001', level: 'locked', severity: 'error',
          service: id, path: `accepts.${cmd}`,
          message: `Service '${id}' accepts command '${cmd}' which is not in the catalog`, deviation: null });
      }
    }
  }

  return violations;
}

// ─── CMD-002: Every sent command exists in the catalog ───────────────────────

function checkCMD002(bc, eco, resolved) {
  const violations = [];
  const commands = eco.contracts?.commands || {};

  for (const [id, svc] of Object.entries(eco.services)) {
    if (!svc.sends) continue;
    for (const cmd of Object.keys(svc.sends)) {
      if (!commands[cmd]) {
        violations.push(makeViolation('CMD-002', bc, id, `sends.${cmd}`,
          `Sent command '${cmd}' is not in the catalog`, eco));
      }
    }
  }
  return violations;
}

// ─── PERS-003: store + publish → consistency: outbox ─────────────────────────

function checkPERS003(bc, eco, resolved) {
  const violations = [];

  for (const [id, svc] of Object.entries(eco.services)) {
    const hasStores = svc.stores && Object.keys(svc.stores).length > 0;
    const hasPublishes = svc.publishes && svc.publishes.length > 0;
    if (!hasStores || !hasPublishes) continue;

    const hasWriteStore = Object.values(svc.stores).some(s => s.pattern !== 'read-only');
    if (!hasWriteStore) continue;

    const eff = resolved.services[id];
    if (eff && eff.consistency !== 'outbox') {
      violations.push(makeViolation('PERS-003', bc, id, 'consistency',
        `Service '${id}' writes stores and publishes events; consistency should be 'outbox' (set by resolver)`,
        eco));
    }
  }
  return violations;
}

// ─── NAME-001: Archetype naming suffixes ─────────────────────────────────────

function checkNAME001(bc, eco, resolved) {
  const violations = [];

  for (const [id, svc] of Object.entries(eco.services)) {
    const archDef = bc.archetypes[svc.archetype];
    if (!archDef?.naming) continue;

    const { idSuffix, nameSuffix } = archDef.naming;
    if (idSuffix && !id.endsWith(idSuffix)) {
      const fix = `${id}${idSuffix}`;
      violations.push(makeViolation('NAME-001', bc, id, 'service',
        `Service id '${id}' should end with '${idSuffix}' for archetype ${svc.archetype}. Suggested fix: rename to '${fix}'.`,
        eco));
    }
  }
  return violations;
}

// ─── DEP-001: No cycles in synchronous calls ─────────────────────────────────

function checkDEP001(bc, eco, resolved) {
  const violations = [];

  // Build adjacency list of sync call edges
  const adj = {};
  for (const [id, svc] of Object.entries(eco.services)) {
    adj[id] = Object.keys(svc.calls || {});
  }

  // DFS cycle detection
  const visited = new Set();
  const stack = new Set();

  function dfs(node, path) {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node).join(' → ');
      return cycle;
    }
    if (visited.has(node)) return null;
    visited.add(node);
    stack.add(node);
    for (const neighbor of (adj[node] || [])) {
      const cycle = dfs(neighbor, [...path, node]);
      if (cycle) return cycle;
    }
    stack.delete(node);
    return null;
  }

  const reported = new Set();
  for (const id of Object.keys(eco.services)) {
    if (!visited.has(id)) {
      const cycle = dfs(id, []);
      if (cycle && !reported.has(cycle)) {
        reported.add(cycle);
        violations.push({ ruleId: 'DEP-001', level: 'locked', severity: 'error',
          service: id, path: 'calls',
          message: `Cycle detected in synchronous calls: ${cycle}`, deviation: null });
      }
    }
  }
  return violations;
}

// ─── COMM-001: Modes allowed by both archetypes; ops exist in target API ─────

function checkCOMM001(bc, eco, resolved) {
  const violations = [];

  for (const [id, svc] of Object.entries(eco.services)) {
    const srcArch = bc.archetypes[svc.archetype];
    if (!srcArch) continue;

    // Check calls
    if (svc.calls) {
      for (const [target, callDef] of Object.entries(svc.calls)) {
        const tgtSvc = eco.services[target];
        if (!tgtSvc) continue;

        const mode = callDef.via || 'rest';
        // Caller must allow outbound rest/grpc
        if (!srcArch.communication.outbound.includes(mode) && !srcArch.communication.outbound.includes('rest')) {
          violations.push(makeViolation('COMM-001', bc, id, `calls.${target}`,
            `Archetype '${svc.archetype}' does not allow outbound '${mode}'`, eco));
        }

        // Target must allow inbound rest/grpc
        const tgtArch = bc.archetypes[tgtSvc.archetype];
        if (tgtArch && !tgtArch.communication.inbound.includes(mode) && !tgtArch.communication.inbound.includes('rest')) {
          violations.push(makeViolation('COMM-001', bc, id, `calls.${target}`,
            `Target archetype '${tgtSvc.archetype}' does not allow inbound '${mode}'`, eco));
        }

        // Verify ops exist in target API
        if (callDef.ops && tgtSvc.api?.rest) {
          for (const op of callDef.ops) {
            if (!tgtSvc.api.rest[op]) {
              violations.push(makeViolation('COMM-001', bc, id, `calls.${target}.ops`,
                `Operation '${op}' is not declared in '${target}' api.rest`, eco));
            }
          }
        }
      }
    }
  }
  return violations;
}

// ─── REF-001: Every referenced entity exists ─────────────────────────────────

function checkREF001(bc, eco, resolved) {
  const violations = [];
  const serviceIds = new Set(Object.keys(eco.services));
  const domainIds = new Set(Object.keys(eco.meta.domains || {}));
  const eventIds = new Set(Object.keys(eco.contracts?.events || {}));
  const commandIds = new Set(Object.keys(eco.contracts?.commands || {}));

  for (const [id, svc] of Object.entries(eco.services)) {
    // Domain reference
    if (svc.domain && !domainIds.has(svc.domain)) {
      violations.push(makeViolation('REF-001', bc, id, 'domain',
        `Domain '${svc.domain}' is not declared in ecosystem.yaml`, eco));
    }

    // calls target services
    if (svc.calls) {
      for (const target of Object.keys(svc.calls)) {
        if (!serviceIds.has(target)) {
          violations.push(makeViolation('REF-001', bc, id, `calls.${target}`,
            `Call target '${target}' is not a known service`, eco));
        }
      }
    }

    // sends.to
    if (svc.sends) {
      for (const [cmd, def] of Object.entries(svc.sends)) {
        if (def.to && !serviceIds.has(def.to)) {
          violations.push(makeViolation('REF-001', bc, id, `sends.${cmd}.to`,
            `Command send target '${def.to}' is not a known service`, eco));
        }
      }
    }

    // consumes topics
    if (svc.consumes) {
      for (const topic of Object.keys(svc.consumes)) {
        if (!eventIds.has(topic)) {
          violations.push(makeViolation('REF-001', bc, id, `consumes.${topic}`,
            `Consumed topic '${topic}' is not in the event catalog`, eco));
        }
      }
    }
  }

  return violations;
}

module.exports = { check };
