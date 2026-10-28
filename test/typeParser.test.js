'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseType } = require('../src/everest/typeParser');

describe('typeParser', () => {
  describe('primitives', () => {
    it('parses uuid', () => {
      const r = parseType('uuid');
      assert.equal(r.kind, 'primitive');
      assert.equal(r.type, 'uuid');
      assert.equal(r.optional, false);
      assert.deepEqual(r.modifiers, []);
    });

    it('parses string', () => {
      const r = parseType('string');
      assert.equal(r.type, 'string');
    });

    it('parses string(n)', () => {
      const r = parseType('string(80)');
      assert.equal(r.type, 'string');
      assert.equal(r.length, 80);
    });

    it('parses int', () => {
      const r = parseType('int');
      assert.equal(r.type, 'int');
    });

    it('parses bool', () => {
      const r = parseType('bool');
      assert.equal(r.type, 'bool');
    });

    it('parses timestamp', () => {
      const r = parseType('timestamp');
      assert.equal(r.type, 'timestamp');
    });

    it('parses date', () => {
      const r = parseType('date');
      assert.equal(r.type, 'date');
    });

    it('parses money', () => {
      const r = parseType('money');
      assert.equal(r.type, 'money');
    });

    it('parses decimal', () => {
      const r = parseType('decimal');
      assert.equal(r.type, 'decimal');
    });

    it('parses decimal(p,s)', () => {
      const r = parseType('decimal(19,4)');
      assert.equal(r.type, 'decimal');
      assert.equal(r.precision, 19);
      assert.equal(r.scale, 4);
    });
  });

  describe('optional', () => {
    it('marks optional with ?', () => {
      const r = parseType('uuid?');
      assert.equal(r.optional, true);
    });

    it('non-optional by default', () => {
      const r = parseType('string');
      assert.equal(r.optional, false);
    });
  });

  describe('collections', () => {
    it('parses list<T>', () => {
      const r = parseType('list<OrderLine>');
      assert.equal(r.kind, 'list');
      assert.equal(r.items.kind, 'named');
      assert.equal(r.items.type, 'OrderLine');
    });

    it('parses list<primitive>', () => {
      const r = parseType('list<string>');
      assert.equal(r.kind, 'list');
      assert.equal(r.items.type, 'string');
    });

    it('parses map<string,T>', () => {
      const r = parseType('map<string,OrderLine>');
      assert.equal(r.kind, 'map');
      assert.equal(r.key, 'string');
      assert.equal(r.value.type, 'OrderLine');
    });
  });

  describe('enums', () => {
    it('parses enum[a, b, c]', () => {
      const r = parseType('enum[placed, paid, cancelled]');
      assert.equal(r.kind, 'enum');
      assert.deepEqual(r.values, ['placed', 'paid', 'cancelled']);
    });

    it('parses enum with two values', () => {
      const r = parseType('enum[active, inactive]');
      assert.deepEqual(r.values, ['active', 'inactive']);
    });
  });

  describe('named types', () => {
    it('parses named type', () => {
      const r = parseType('PlaceOrder');
      assert.equal(r.kind, 'named');
      assert.equal(r.type, 'PlaceOrder');
    });
  });

  describe('modifiers', () => {
    it('parses pk modifier', () => {
      const r = parseType('uuid pk');
      assert.equal(r.modifiers.length, 1);
      assert.equal(r.modifiers[0].modifier, 'pk');
    });

    it('parses fk(Entity)', () => {
      const r = parseType('uuid fk(Order)');
      assert.equal(r.modifiers[0].modifier, 'fk');
      assert.equal(r.modifiers[0].entity, 'Order');
    });

    it('parses fk cascade', () => {
      const r = parseType('uuid fk(Order) cascade');
      assert.equal(r.modifiers.length, 2);
      assert.equal(r.modifiers[0].modifier, 'fk');
      assert.equal(r.modifiers[1].modifier, 'cascade');
    });

    it('parses index unique', () => {
      const r = parseType('string index unique');
      assert.equal(r.modifiers.length, 2);
      assert.equal(r.modifiers[0].modifier, 'index');
      assert.equal(r.modifiers[1].modifier, 'unique');
    });

    it('parses min(n)', () => {
      const r = parseType('int min(1)');
      assert.equal(r.modifiers[0].modifier, 'min');
      assert.equal(r.modifiers[0].value, 1);
    });

    it('parses max(n)', () => {
      const r = parseType('int max(100)');
      assert.equal(r.modifiers[0].modifier, 'max');
      assert.equal(r.modifiers[0].value, 100);
    });
  });

  describe('errors', () => {
    it('throws on empty string', () => {
      assert.throws(() => parseType(''), /empty type string/);
    });

    it('throws on unknown type token', () => {
      // 'float' looks like an identifier but is not a known type or named type pattern
      // Named types (CamelCase) are allowed; unknown lowercase keywords are not
      assert.throws(() => parseType('float badmod'), /unknown modifier/);
    });

    it('throws on unknown modifier', () => {
      assert.throws(() => parseType('string badmod'), /unknown modifier/);
    });

    it('includes context in error', () => {
      assert.throws(() => parseType('string badmod', 'services/foo.yaml:stores.bar.id'),
        /services\/foo.yaml:stores.bar.id/);
    });
  });
});
