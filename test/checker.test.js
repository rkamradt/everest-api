'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBasecamp, loadEcosystem, resolve, check } = require('../src/everest');

let bc;

function readDir(dir) {
  const files = {};
  const walk = (base, prefix) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files[rel] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return files;
}

// Helper: build a minimal ecosystem around a set of service overrides
function makeEco(services, opts = {}) {
  return {
    meta: {
      ecosystem: 'test',
      extends: 'everest-basecamp@1.0',
      domains: { a: 'Domain A', b: 'Domain B', ...(opts.domains || {}) },
      profiles: {},
    },
    contracts: {
      events: opts.events || {},
      commands: opts.commands || {},
      types: opts.types || {},
    },
    services,
  };
}

before(() => {
  bc = loadBasecamp(readDir(path.join(__dirname, '..', 'seed', 'basecamp')));
});

describe('checker', () => {
  describe('ARCH-001: store ownership', () => {
    it('passes when stores are owned by exactly one service', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', stores: { orders: { kind: 'relational', pattern: 'crud' } } },
        s2: { service: 's2', archetype: 'http', domain: 'b', stores: { products: { kind: 'relational', pattern: 'crud' } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'ARCH-001');
      assert.equal(vs.length, 0);
    });

    it('fails when two services share a store name', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', stores: { orders: { kind: 'relational', pattern: 'crud' } } },
        s2: { service: 's2', archetype: 'http', domain: 'b', stores: { orders: { kind: 'relational', pattern: 'crud' } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'ARCH-001');
      assert.equal(vs.length, 1);
      assert.equal(vs[0].severity, 'error');
    });
  });

  describe('ARCH-010: cross-domain sync calls', () => {
    it('passes for same-domain calls', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', api: { rest: { 'GET /x': { out: 'string' } } } },
        s2: { service: 's2', archetype: 'http', domain: 'a', calls: { s1: { via: 'rest', ops: ['GET /x'] } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'ARCH-010');
      assert.equal(vs.length, 0);
    });

    it('fails for cross-domain calls without deviation', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', api: { rest: { 'GET /x': { out: 'string' } } } },
        s2: { service: 's2', archetype: 'http', domain: 'b', calls: { s1: { via: 'rest', ops: ['GET /x'] } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'ARCH-010');
      assert.equal(vs.length, 1);
      assert.equal(vs[0].severity, 'error');
    });

    it('downgrades to warning with accepted deviation', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', api: { rest: { 'GET /x': { out: 'string' } } } },
        s2: {
          service: 's2', archetype: 'http', domain: 'b',
          calls: { s1: { via: 'rest', ops: ['GET /x'] } },
          deviations: { 'ARCH-010': { reason: 'Must have live data', scope: 'calls.s1' } },
        },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'ARCH-010');
      assert.equal(vs.length, 1);
      assert.equal(vs[0].severity, 'warning');
      assert.ok(vs[0].deviation);
    });

    it('gateway is exempt from ARCH-010', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', api: { rest: { 'GET /x': { out: 'string' } } } },
        gw: { service: 'gw', archetype: 'gateway', domain: 'b', calls: { s1: { via: 'rest', ops: ['GET /x'] } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'ARCH-010');
      assert.equal(vs.length, 0);
    });
  });

  describe('ARCH-020: provider/adaptor store kinds', () => {
    it('passes for kv store in provider', () => {
      const eco = makeEco({
        p1: { service: 'payment-provider', archetype: 'provider', domain: 'a',
          foreign: { outbound: { name: 'Stripe' } }, publishes: ['foo'],
          stores: { cache: { kind: 'kv', pattern: 'crud' } } },
      }, { events: { foo: { owner: 'payment-provider', version: 1, schema: {} } } });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'ARCH-020');
      assert.equal(vs.length, 0);
    });

    it('fails for relational store in provider', () => {
      const eco = makeEco({
        p1: { service: 'payment-provider', archetype: 'provider', domain: 'a',
          foreign: { outbound: { name: 'Stripe' } }, publishes: ['foo'],
          stores: { data: { kind: 'relational', pattern: 'crud' } } },
      }, { events: { foo: { owner: 'payment-provider', version: 1, schema: {} } } });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'ARCH-020');
      assert.equal(vs.length, 1);
      assert.equal(vs[0].severity, 'error');
    });
  });

  describe('EVT-001: event ownership', () => {
    it('passes when publisher matches catalog owner', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', publishes: ['order.placed'] },
      }, { events: { 'order.placed': { owner: 's1', version: 1, schema: {} } } });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'EVT-001');
      assert.equal(vs.length, 0);
    });

    it('fails when publisher does not match catalog owner', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', publishes: ['order.placed'] },
      }, { events: { 'order.placed': { owner: 's2', version: 1, schema: {} } } });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'EVT-001');
      assert.ok(vs.length > 0);
    });

    it('fails when event published but not in catalog', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', publishes: ['unknown.event'] },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'EVT-001');
      assert.ok(vs.length > 0);
    });
  });

  describe('EVT-002: consumed events in catalog', () => {
    it('passes when consumed event is in catalog', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', publishes: ['order.placed'] },
        s2: { service: 's2', archetype: 'messaging', domain: 'a', consumes: { 'order.placed': { handler: 'h' } } },
      }, { events: { 'order.placed': { owner: 's1', version: 1, schema: {} } } });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'EVT-002');
      assert.equal(vs.length, 0);
    });

    it('fails when consumed event is not in catalog', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'messaging', domain: 'a', consumes: { 'ghost.event': { handler: 'h' } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'EVT-002');
      assert.equal(vs.length, 1);
    });
  });

  describe('CMD-001: command ownership', () => {
    it('passes when acceptor matches catalog receiver', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'provider', domain: 'a',
          foreign: { outbound: { name: 'X' } }, publishes: ['ev'],
          accepts: { 'pay.charge': { handler: 'h' } } },
      }, {
        events: { ev: { owner: 's1', version: 1, schema: {} } },
        commands: { 'pay.charge': { receiver: 's1', version: 1, schema: {} } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'CMD-001');
      assert.equal(vs.length, 0);
    });

    it('fails when command accepted but not in catalog', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', accepts: { 'ghost.cmd': { handler: 'h' } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'CMD-001');
      assert.ok(vs.length > 0);
    });
  });

  describe('CMD-002: sent commands in catalog', () => {
    it('fails when sent command is not in catalog', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', sends: { 'ghost.cmd': { to: 's2' } } },
        s2: { service: 's2', archetype: 'http', domain: 'a' },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'CMD-002');
      assert.equal(vs.length, 1);
    });
  });

  describe('PERS-003: consistency outbox', () => {
    it('derives outbox for service with stores and publishes', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a',
          stores: { orders: { kind: 'relational', pattern: 'crud' } },
          publishes: ['ev'] },
      }, { events: { ev: { owner: 's1', version: 1, schema: {} } } });
      const r = resolve(bc, eco);
      assert.equal(r.services['s1'].consistency, 'outbox');
      // No PERS-003 violation since resolver set it
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'PERS-003');
      assert.equal(vs.length, 0);
    });
  });

  describe('NAME-001: archetype naming', () => {
    it('fails when provider id missing -provider suffix', () => {
      const eco = makeEco({
        stripe: { service: 'stripe', archetype: 'provider', domain: 'a',
          foreign: { outbound: { name: 'S' } }, publishes: ['ev'] },
      }, { events: { ev: { owner: 'stripe', version: 1, schema: {} } } });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'NAME-001');
      assert.equal(vs.length, 1);
      assert.ok(vs[0].message.includes('-provider'));
    });

    it('passes when provider id has correct suffix', () => {
      const eco = makeEco({
        'stripe-provider': { service: 'stripe-provider', archetype: 'provider', domain: 'a',
          foreign: { outbound: { name: 'S' } }, publishes: ['ev'] },
      }, { events: { ev: { owner: 'stripe-provider', version: 1, schema: {} } } });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'NAME-001');
      assert.equal(vs.length, 0);
    });
  });

  describe('DEP-001: no cycles', () => {
    it('passes with no cycles', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', api: { rest: { 'GET /x': {} } } },
        s2: { service: 's2', archetype: 'http', domain: 'a', calls: { s1: { via: 'rest', ops: ['GET /x'] } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'DEP-001');
      assert.equal(vs.length, 0);
    });

    it('fails with a two-node cycle', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a',
          api: { rest: { 'GET /x': {} } }, calls: { s2: { via: 'rest' } } },
        s2: { service: 's2', archetype: 'http', domain: 'a',
          api: { rest: { 'GET /y': {} } }, calls: { s1: { via: 'rest' } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'DEP-001');
      assert.ok(vs.length > 0);
      assert.equal(vs[0].severity, 'error');
    });
  });

  describe('COMM-001: allowed modes and ops', () => {
    it('fails when called op does not exist in target API', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', api: { rest: { 'GET /x': {} } } },
        s2: { service: 's2', archetype: 'http', domain: 'a',
          calls: { s1: { via: 'rest', ops: ['GET /nonexistent'] } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'COMM-001');
      assert.ok(vs.length > 0);
      assert.ok(vs[0].message.includes('GET /nonexistent'));
    });

    it('passes when op exists in target API', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a', api: { rest: { 'GET /x': {} } } },
        s2: { service: 's2', archetype: 'http', domain: 'a',
          calls: { s1: { via: 'rest', ops: ['GET /x'] } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'COMM-001');
      assert.equal(vs.length, 0);
    });
  });

  describe('REF-001: references exist', () => {
    it('fails when domain is unknown', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'unknown-domain' },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'REF-001');
      assert.ok(vs.length > 0);
      assert.ok(vs[0].message.includes('unknown-domain'));
    });

    it('fails when call target is unknown', () => {
      const eco = makeEco({
        s1: { service: 's1', archetype: 'http', domain: 'a',
          calls: { 'ghost-service': { via: 'rest' } } },
      });
      const r = resolve(bc, eco);
      const vs = check(bc, eco, r).filter(v => v.ruleId === 'REF-001');
      assert.ok(vs.length > 0);
      assert.ok(vs[0].message.includes('ghost-service'));
    });
  });

  describe('kiosk-commerce fixture', () => {
    it('validates with 0 errors', () => {
      const basecampFiles = readDir(path.join(__dirname, '..', 'seed', 'basecamp'));
      const ecoFiles = readDir(path.join(__dirname, '..', 'fixtures', 'kiosk-commerce'));
      const fixtureBC = loadBasecamp(basecampFiles);
      const fixtureEco = loadEcosystem(ecoFiles);
      const fixtureResolved = resolve(fixtureBC, fixtureEco);
      const violations = check(fixtureBC, fixtureEco, fixtureResolved);
      const errors = violations.filter(v => v.severity === 'error');
      assert.equal(errors.length, 0, `Expected 0 errors, got: ${JSON.stringify(errors, null, 2)}`);
    });
  });
});
