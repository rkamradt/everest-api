#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadBasecamp, loadEcosystem, resolve, check, renderEffective, renderViolations } = require('../src/everest');

// ─── File system helpers ──────────────────────────────────────────────────────

function readDir(dir) {
  const files = {};
  const walk = (base, prefix) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files[rel] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir, '');
  return files;
}

function readBasecampFiles(seedDir) {
  const dir = (seedDir && fs.existsSync(seedDir)) ? seedDir : path.join(__dirname, '..', 'seed', 'basecamp');
  return readDir(dir);
}

function readEcosystemFiles(ecoDir) {
  return readDir(ecoDir);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdValidate(args) {
  const ecoDir = args[0];
  if (!ecoDir) {
    console.error('Usage: everest validate <ecosystem-dir>');
    process.exit(1);
  }

  const basecampFiles = readBasecampFiles();
  const ecoFiles = readEcosystemFiles(path.resolve(ecoDir));

  let bc, eco, resolved, violations;
  try {
    bc = loadBasecamp(basecampFiles);
  } catch (e) {
    console.error('Basecamp load error:', e.message);
    process.exit(1);
  }

  try {
    eco = loadEcosystem(ecoFiles);
  } catch (e) {
    console.error('Ecosystem load error:', e.message);
    process.exit(1);
  }

  try {
    resolved = resolve(bc, eco);
  } catch (e) {
    console.error('Resolver error:', e.message);
    process.exit(1);
  }

  violations = check(bc, eco, resolved);

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  process.stdout.write(renderViolations(violations));

  console.log(`\nSummary: ${Object.keys(eco.services).length} services, ` +
    `${errors.length} errors, ${warnings.length} warnings`);

  if (errors.length > 0) process.exit(1);
}

function cmdEffective(args) {
  const [ecoDir, serviceId, ...rest] = args;
  if (!ecoDir || !serviceId) {
    console.error('Usage: everest effective <ecosystem-dir> <service-id> [--profile <name>]');
    process.exit(1);
  }

  let profile = null;
  const pidx = rest.indexOf('--profile');
  if (pidx >= 0 && rest[pidx + 1]) profile = rest[pidx + 1];

  const basecampFiles = readBasecampFiles();
  const ecoFiles = readEcosystemFiles(path.resolve(ecoDir));

  let bc, eco, resolved;
  try {
    bc = loadBasecamp(basecampFiles);
  } catch (e) {
    console.error('Basecamp load error:', e.message);
    process.exit(1);
  }

  try {
    eco = loadEcosystem(ecoFiles);
  } catch (e) {
    console.error('Ecosystem load error:', e.message);
    process.exit(1);
  }

  if (!eco.services[serviceId]) {
    console.error(`Service '${serviceId}' not found in ecosystem '${eco.meta.ecosystem}'`);
    console.error(`Known services: ${Object.keys(eco.services).join(', ')}`);
    process.exit(1);
  }

  try {
    resolved = resolve(bc, eco, { profile });
  } catch (e) {
    console.error('Resolver error:', e.message);
    process.exit(1);
  }

  const eff = resolved.services[serviceId];
  const yaml = renderEffective(eff, serviceId);

  console.log(`# Effective spec: ${serviceId}` + (profile ? ` (profile: ${profile})` : ''));
  console.log(`# Ecosystem: ${eco.meta.ecosystem}`);
  console.log(`# Basecamp: ${bc.basecamp.basecamp}@${bc.basecamp.version}`);
  console.log('');
  process.stdout.write(yaml);

  // Show violations for this service
  const violations = check(bc, eco, resolved).filter(v => v.service === serviceId);
  if (violations.length > 0) {
    console.log('\n# Violations for this service:');
    process.stdout.write(renderViolations(violations));
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;
switch (cmd) {
  case 'validate': cmdValidate(rest); break;
  case 'effective': cmdEffective(rest); break;
  default:
    console.error('Usage: everest <validate|effective> [args...]');
    console.error('  validate <ecosystem-dir>                        Validate all rules');
    console.error('  effective <ecosystem-dir> <service> [--profile] Show effective spec');
    process.exit(1);
}
