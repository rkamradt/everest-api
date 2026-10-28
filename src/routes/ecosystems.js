'use strict';

const express = require('express');
const YAML = require('yaml');
const {
  listEcosystems, createEcosystem, readEcosystemFiles,
  loadAndResolve, writeEcosystemFile, getHistory,
  getDiff, undoHead, listVersions, publishVersion, suggestVersionBump,
} = require('../gitStore');
const { renderEffective, renderViolations } = require('../everest');
const messagesRouter = require('./messages');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function author(req) {
  const payload = req.auth.payload;
  return {
    name: payload.name || payload.preferred_username || payload.sub,
    email: payload.email || `${payload.sub}@everest`,
  };
}

function asyncWrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─── GET /api/ecosystems ──────────────────────────────────────────────────────

router.get('/', asyncWrap(async (req, res) => {
  const names = await listEcosystems();
  const items = await Promise.all(names.map(async name => {
    try {
      const files = await readEcosystemFiles(name);
      const meta = YAML.parse(files['ecosystem.yaml'] || '{}');
      return { name, description: meta.description, extends: meta.extends };
    } catch (_) {
      return { name };
    }
  }));
  res.json(items);
}));

// ─── POST /api/ecosystems ─────────────────────────────────────────────────────

router.post('/', asyncWrap(async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const a = author(req);
  const result = await createEcosystem(name, description, a.name, a.email);
  res.status(201).json(result);
}));

// ─── GET /api/basecamp ────────────────────────────────────────────────────────

router.get('/basecamp', asyncWrap(async (req, res) => {
  // This is handled at app level but keep here too for flexibility
  res.status(404).json({ error: 'Use /api/basecamp' });
}));

// ─── GET /api/ecosystems/:name/files ─────────────────────────────────────────

router.get('/:name/files', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const ref = req.query.ref || 'HEAD';
  const files = await readEcosystemFiles(name, ref);
  res.json(files);
}));

// ─── PUT /api/ecosystems/:name/files/* ───────────────────────────────────────

router.put('/:name/files/*', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const filePath = req.params[0];
  const content = req.body.content;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'body.content must be a string' });
  }

  const a = author(req);
  const result = await writeEcosystemFile(
    name, filePath, content, a,
    `Edit ${filePath}`,
    req.body.prompt || ''
  );

  if (result.errors?.length) {
    return res.status(422).json({ errors: result.errors });
  }
  res.json(result);
}));

// ─── DELETE /api/ecosystems/:name/files/* ────────────────────────────────────

router.delete('/:name/files/*', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const filePath = req.params[0];
  const a = author(req);
  const result = await writeEcosystemFile(
    name, filePath, null, a,
    `Delete ${filePath}`
  );
  if (result.errors?.length) {
    return res.status(422).json({ errors: result.errors });
  }
  res.json(result);
}));

// ─── GET /api/ecosystems/:name/effective ─────────────────────────────────────

router.get('/:name/effective', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const ref = req.query.ref || 'HEAD';
  const profile = req.query.profile || null;

  const { resolved, eco } = await loadAndResolve(name, ref, profile);

  const result = {};
  for (const [id, eff] of Object.entries(resolved.services)) {
    result[id] = eff;
  }
  res.json({ services: result, topology: resolved.topology });
}));

// ─── GET /api/ecosystems/:name/effective/:service ─────────────────────────────

router.get('/:name/effective/:service', asyncWrap(async (req, res) => {
  const { name, service } = req.params;
  const ref = req.query.ref || 'HEAD';
  const profile = req.query.profile || null;

  const { resolved } = await loadAndResolve(name, ref, profile);
  const eff = resolved.services[service];
  if (!eff) return res.status(404).json({ error: `Service '${service}' not found` });

  if (req.accepts('text/plain')) {
    res.type('text/plain').send(renderEffective(eff, service));
  } else {
    res.json(eff);
  }
}));

// ─── GET /api/ecosystems/:name/violations ─────────────────────────────────────

router.get('/:name/violations', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const ref = req.query.ref || 'HEAD';
  const { violations } = await loadAndResolve(name, ref);
  res.json(violations);
}));

// ─── GET /api/ecosystems/:name/history ────────────────────────────────────────

router.get('/:name/history', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const history = await getHistory(name);
  res.json(history);
}));

// ─── GET /api/ecosystems/:name/diff ──────────────────────────────────────────

router.get('/:name/diff', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const { from, to = 'HEAD' } = req.query;
  if (!from) return res.status(400).json({ error: 'from is required' });
  const diff = await getDiff(name, from, to);
  res.json(diff);
}));

// ─── POST /api/ecosystems/:name/undo ─────────────────────────────────────────

router.post('/:name/undo', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const a = author(req);
  const result = await undoHead(name, a);
  res.json(result);
}));

// ─── GET /api/ecosystems/:name/versions ──────────────────────────────────────

router.get('/:name/versions', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const [versions, suggested] = await Promise.all([
    listVersions(name),
    suggestVersionBump(name),
  ]);
  res.json({ versions, suggestedBump: suggested });
}));

// ─── POST /api/ecosystems/:name/versions ─────────────────────────────────────

router.post('/:name/versions', asyncWrap(async (req, res) => {
  const { name } = req.params;
  const { bump, notes } = req.body;
  if (!['major', 'minor', 'patch'].includes(bump)) {
    return res.status(400).json({ error: 'bump must be major, minor or patch' });
  }
  const a = author(req);
  try {
    const result = await publishVersion(name, bump, notes, a);
    res.status(201).json(result);
  } catch (e) {
    if (e.statusCode === 409) {
      return res.status(409).json({ error: e.message, violations: e.violations });
    }
    throw e;
  }
}));

// Mount messages sub-router (mergeParams: true on its router lets :name flow through)
router.use('/:name/messages', messagesRouter);

module.exports = router;
