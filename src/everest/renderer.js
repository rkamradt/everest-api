'use strict';

const YAML = require('yaml');

/**
 * Render an effective spec as YAML with provenance comments.
 *
 * @param {object} effective  Output from resolver (a single service's effective spec)
 * @param {string} [serviceId]
 * @returns {string}  YAML text with inline provenance comments
 */
function renderEffective(effective, serviceId = '') {
  const provenance = effective._provenance || {};

  // Build a clean copy without internal _ keys
  const clean = stripInternal(effective);

  // Convert to YAML document
  const doc = YAML.parseDocument(YAML.stringify(clean));

  // Annotate with provenance comments
  annotateNode(doc.contents, provenance, '');

  return doc.toString();
}

function stripInternal(obj) {
  if (Array.isArray(obj)) return obj.map(stripInternal);
  if (obj !== null && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      out[k] = stripInternal(v);
    }
    return out;
  }
  return obj;
}

function annotateNode(node, provenance, prefix) {
  if (!node) return;

  if (node.type === 'MAP' || (node.items && node.tag !== 'tag:yaml.org,2002:seq')) {
    if (!node.items) return;
    for (const pair of node.items) {
      const key = pair.key?.value;
      if (!key) continue;
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const src = provenance[fullKey];
      if (src) {
        // Add comment on the value node
        if (pair.value) {
          const existing = pair.value.commentBefore || '';
          // Only annotate leaf values to avoid cluttering maps
          if (!pair.value.items) {
            pair.value.comment = ` ← ${src}`;
          }
        }
      }
      // Recurse
      if (pair.value?.items) {
        annotateNode(pair.value, provenance, fullKey);
      }
    }
  }
}

/**
 * Format violations for display.
 * @param {import('./checker').Violation[]} violations
 * @returns {string}
 */
function renderViolations(violations) {
  if (violations.length === 0) return '✓ No violations\n';

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  const lines = [];

  if (errors.length) {
    lines.push(`Errors (${errors.length}):`);
    for (const v of errors) {
      lines.push(`  [${v.ruleId}] ${v.service} > ${v.path}`);
      lines.push(`    ${v.message}`);
      if (v.deviation) {
        lines.push(`    Deviation: ${v.deviation.reason}${v.deviation.scope ? ` (scope: ${v.deviation.scope})` : ''}`);
      }
    }
  }

  if (warnings.length) {
    if (lines.length) lines.push('');
    lines.push(`Warnings (${warnings.length}):`);
    for (const v of warnings) {
      lines.push(`  [${v.ruleId}] ${v.service} > ${v.path}`);
      lines.push(`    ${v.message}`);
      if (v.deviation) {
        lines.push(`    Accepted deviation: ${v.deviation.reason}${v.deviation.scope ? ` (scope: ${v.deviation.scope})` : ''}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

module.exports = { renderEffective, renderViolations };
