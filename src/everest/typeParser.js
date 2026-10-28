'use strict';

// Type shorthand parser for the Everest language.
// Parses field definitions like: "uuid pk", "string(80) index unique", "list<OrderLine>",
// "enum[placed, paid, cancelled]", "decimal(19,4)", "uuid fk(Order) cascade"

const PRIMITIVES = new Set(['uuid', 'string', 'int', 'decimal', 'bool', 'timestamp', 'date', 'money']);
const MODIFIERS = new Set(['pk', 'fk', 'index', 'unique', 'min', 'max', 'cascade']);

/**
 * Parse a type string into a structured object.
 * @param {string} raw  The raw type string, e.g. "uuid fk(Order) cascade"
 * @param {string} [context]  File:path context for error messages
 * @returns {{ base: string, params?: string[], optional: boolean, modifiers: object[] }}
 * @throws {Error} with file+path context on parse failure
 */
function parseType(raw, context = '') {
  if (typeof raw !== 'string') {
    throw new TypeError(`${context}: expected a type string, got ${typeof raw}`);
  }
  const src = raw.trim();
  if (!src) throw new Error(`${context}: empty type string`);

  const lexer = new Lexer(src, context);
  return parseTypeExpr(lexer, context);
}

function parseTypeExpr(lexer, context) {
  const base = parseBaseType(lexer, context);
  const optional = lexer.peek() === '?' ? (lexer.consume(), true) : false;
  const modifiers = [];
  while (lexer.hasMore()) {
    const next = lexer.peekChar();
    if (next === '>' || next === ']' || next === ')' || next === ',') break;
    const mod = parseModifier(lexer, context);
    if (mod) modifiers.push(mod);
    else break;
  }
  return { ...base, optional, modifiers };
}

function parseBaseType(lexer, context) {
  const tok = lexer.nextToken();
  if (!tok) throw new Error(`${context}: unexpected end of type string`);

  // list<T>
  if (tok === 'list') {
    lexer.expectChar('<');
    const inner = parseTypeExpr(lexer, context);
    lexer.expectChar('>');
    return { kind: 'list', items: inner };
  }

  // map<K, V>  (key must be primitive for v1)
  if (tok === 'map') {
    lexer.expectChar('<');
    const keyTok = lexer.nextToken();
    if (!keyTok) throw new Error(`${context}: expected map key type`);
    lexer.expectChar(',');
    const valType = parseTypeExpr(lexer, context);
    lexer.expectChar('>');
    return { kind: 'map', key: keyTok, value: valType };
  }

  // enum[a, b, c]
  if (tok === 'enum') {
    lexer.expectChar('[');
    const values = [];
    while (true) {
      const v = lexer.nextEnumValue();
      if (!v) throw new Error(`${context}: expected enum value`);
      values.push(v.trim());
      const sep = lexer.peekChar();
      if (sep === ']') { lexer.consumeChar(); break; }
      if (sep === ',') { lexer.consumeChar(); continue; }
      throw new Error(`${context}: expected ',' or ']' in enum, got '${sep}'`);
    }
    return { kind: 'enum', values };
  }

  // string(n)
  if (tok === 'string') {
    if (lexer.peekChar() === '(') {
      lexer.consumeChar();
      const n = lexer.nextNumber(context);
      lexer.expectChar(')');
      return { kind: 'primitive', type: 'string', length: n };
    }
    return { kind: 'primitive', type: 'string' };
  }

  // decimal(p,s)
  if (tok === 'decimal') {
    if (lexer.peekChar() === '(') {
      lexer.consumeChar();
      const p = lexer.nextNumber(context);
      lexer.expectChar(',');
      const s = lexer.nextNumber(context);
      lexer.expectChar(')');
      return { kind: 'primitive', type: 'decimal', precision: p, scale: s };
    }
    return { kind: 'primitive', type: 'decimal' };
  }

  // other primitives
  if (PRIMITIVES.has(tok)) {
    return { kind: 'primitive', type: tok };
  }

  // named type (from contracts/types.yaml or inline)
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(tok)) {
    return { kind: 'named', type: tok };
  }

  throw new Error(`${context}: unknown type token '${tok}'`);
}

function parseModifier(lexer, context) {
  const tok = lexer.nextToken();
  if (!tok) return null;

  if (!MODIFIERS.has(tok)) {
    throw new Error(`${context}: unknown modifier '${tok}'`);
  }

  if (tok === 'fk') {
    lexer.expectChar('(');
    const entity = lexer.nextToken();
    if (!entity) throw new Error(`${context}: expected entity name in fk()`);
    lexer.expectChar(')');
    return { modifier: 'fk', entity };
  }

  if (tok === 'min' || tok === 'max') {
    lexer.expectChar('(');
    const n = lexer.nextNumber(context);
    lexer.expectChar(')');
    return { modifier: tok, value: n };
  }

  return { modifier: tok };
}

class Lexer {
  constructor(src, context) {
    this.src = src;
    this.pos = 0;
    this.context = context;
  }

  hasMore() {
    this.skipSpace();
    return this.pos < this.src.length;
  }

  peek() {
    this.skipSpace();
    if (this.pos >= this.src.length) return null;
    // Check for special single chars
    const ch = this.src[this.pos];
    if ('<>[](),?'.includes(ch)) return ch;
    return null;
  }

  peekChar() {
    this.skipSpace();
    if (this.pos >= this.src.length) return null;
    return this.src[this.pos];
  }

  consume() { this.pos++; }
  consumeChar() { this.pos++; }

  expectChar(ch) {
    this.skipSpace();
    if (this.src[this.pos] !== ch) {
      throw new Error(`${this.context}: expected '${ch}' at position ${this.pos} in '${this.src}', got '${this.src[this.pos]}'`);
    }
    this.pos++;
  }

  nextToken() {
    this.skipSpace();
    if (this.pos >= this.src.length) return null;
    const ch = this.src[this.pos];
    // Stop on structural chars
    if ('<>[](),?'.includes(ch)) return null;
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos])) {
      this.pos++;
    }
    if (this.pos === start) return null;
    return this.src.slice(start, this.pos);
  }

  nextNumber(context) {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) {
      this.pos++;
    }
    if (this.pos === start) throw new Error(`${context}: expected number at position ${this.pos} in '${this.src}'`);
    return parseInt(this.src.slice(start, this.pos), 10);
  }

  nextEnumValue() {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.src.length && this.src[this.pos] !== ',' && this.src[this.pos] !== ']') {
      this.pos++;
    }
    const v = this.src.slice(start, this.pos).trim();
    return v || null;
  }

  skipSpace() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos++;
    }
  }
}

/**
 * Validate that named types in an entity map exist in the type catalog.
 * @param {object} entityFields  Map of fieldName → typeString
 * @param {Set<string>} knownTypes  Set of defined type names
 * @param {string} context  File:path for errors
 * @returns {string[]}  Array of error messages
 */
function validateEntityTypes(entityFields, knownTypes, context) {
  const errors = [];
  for (const [field, typeStr] of Object.entries(entityFields)) {
    try {
      const parsed = parseType(String(typeStr), `${context}.${field}`);
      collectNamedTypes(parsed).forEach(name => {
        if (!PRIMITIVES.has(name) && name !== 'money' && !knownTypes.has(name)) {
          errors.push(`${context}.${field}: unknown named type '${name}'`);
        }
      });
    } catch (e) {
      errors.push(e.message);
    }
  }
  return errors;
}

function collectNamedTypes(parsed) {
  if (!parsed) return [];
  const names = [];
  if (parsed.kind === 'named') names.push(parsed.type);
  if (parsed.items) names.push(...collectNamedTypes(parsed.items));
  if (parsed.value) names.push(...collectNamedTypes(parsed.value));
  return names;
}

module.exports = { parseType, validateEntityTypes, collectNamedTypes };
