'use strict';

/**
 * Git store for Everest ecosystem repos.
 *
 * Layout under EVEREST_DATA_DIR (default /data):
 *   basecamp/          – everest-basecamp repo (read-only in v1 via API)
 *   ecosystems/<name>/ – one git repo per ecosystem
 *
 * Invariants:
 *   - Every accepted change = exactly one commit on main
 *   - Writes per ecosystem are serialized via an in-process mutex map
 *   - Published versions = immutable annotated tags (v<semver>)
 *   - Resolution uses the basecamp at the tag named in ecosystem.yaml `extends`
 */

const path = require('path');
const fs = require('fs');
const fsP = require('fs/promises');
const simpleGit = require('simple-git');
const { loadBasecamp, loadEcosystem, resolve, check } = require('./everest');

const DATA_DIR = process.env.EVEREST_DATA_DIR || '/data';
const BASECAMP_DIR = path.join(DATA_DIR, 'basecamp');
const ECOSYSTEMS_DIR = path.join(DATA_DIR, 'ecosystems');

// ─── Mutex map ────────────────────────────────────────────────────────────────

const mutexMap = new Map(); // name → Promise (tail of serialized queue)

function withEcosystemLock(name, fn) {
  const prev = mutexMap.get(name) || Promise.resolve();
  const next = prev.then(fn).catch(err => { throw err; });
  // Keep the tail, but don't let rejections block the queue
  mutexMap.set(name, next.catch(() => {}));
  return next;
}

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Ensure basecamp is initialized from seed on first start.
 * Call once at server startup.
 */
async function ensureBasecamp() {
  await fsP.mkdir(BASECAMP_DIR, { recursive: true });
  await fsP.mkdir(ECOSYSTEMS_DIR, { recursive: true });

  const git = simpleGit(BASECAMP_DIR);
  const isRepo = await git.checkIsRepo().catch(() => false);

  if (!isRepo) {
    const seedDir = path.join(__dirname, '..', 'seed', 'basecamp');
    if (!fs.existsSync(seedDir)) {
      throw new Error('seed/basecamp/ not found; cannot initialize basecamp');
    }

    await git.init();
    await git.addConfig('user.name', 'Everest');
    await git.addConfig('user.email', 'everest@local');

    // Copy seed files into BASECAMP_DIR
    await copyDir(seedDir, BASECAMP_DIR);

    await git.add('.');
    await git.commit('Initial basecamp v1.0.0');
    await git.addAnnotatedTag('v1.0.0', 'Everest basecamp v1.0.0');
    console.log('Basecamp initialized from seed and tagged v1.0.0');
  }
}

async function copyDir(src, dest) {
  const entries = await fsP.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fsP.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fsP.copyFile(srcPath, destPath);
    }
  }
}

// ─── Basecamp reads ───────────────────────────────────────────────────────────

/**
 * Return the list of basecamp tags (versions).
 */
async function basecampVersions() {
  const git = simpleGit(BASECAMP_DIR);
  const tags = await git.tags();
  const result = [];
  for (const tag of tags.all) {
    const log = await git.show([`${tag}`, '--format=%H%n%ai%n%s', '--no-patch']);
    const [sha, date, summary] = log.trim().split('\n');
    result.push({ tag, sha, date, summary });
  }
  return result;
}

/**
 * Read all basecamp files at a given tag.
 * @param {string} tag  e.g. 'v1.0.0'
 * @returns {object}  { path: content }
 */
async function readBasecampAtTag(tag) {
  const git = simpleGit(BASECAMP_DIR);
  const lsTree = await git.raw(['ls-tree', '-r', '--name-only', tag]);
  const files = lsTree.trim().split('\n').filter(Boolean);
  const result = {};
  for (const file of files) {
    try {
      result[file] = await git.show([`${tag}:${file}`]);
    } catch (_) { /* skip unreadable */ }
  }
  return result;
}

/**
 * Parse the basecamp tag from an ecosystem `extends` field.
 * e.g. "everest-basecamp@1.0" → "v1.0.0" (look for best matching tag)
 */
async function resolveBasecampTag(extendsField) {
  // Strip "everest-basecamp@" prefix
  const ver = extendsField.replace(/^everest-basecamp@/, '').trim();
  const git = simpleGit(BASECAMP_DIR);
  const tags = await git.tags();

  // Exact match first (v1.0 or v1.0.0)
  const candidates = tags.all.filter(t => {
    const tv = t.replace(/^v/, '');
    return tv === ver || tv.startsWith(ver + '.');
  });
  if (candidates.length === 0) {
    throw new Error(`Basecamp tag matching '${extendsField}' not found`);
  }
  // Return latest matching tag (lexicographic, which works for semver)
  return candidates.sort().pop();
}

// ─── Ecosystem helpers ────────────────────────────────────────────────────────

function ecoPath(name) {
  return path.join(ECOSYSTEMS_DIR, name);
}

function ecoGit(name) {
  return simpleGit(ecoPath(name));
}

function isValidPath(p) {
  if (!p) return false;
  const allowed = /^(ecosystem\.yaml|contracts\/(events|commands|types)\.yaml|services\/[a-z0-9][a-z0-9-]*\.yaml)$/;
  return allowed.test(p);
}

/**
 * List all known ecosystem names.
 */
async function listEcosystems() {
  try {
    const entries = await fsP.readdir(ECOSYSTEMS_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch (_) {
    return [];
  }
}

/**
 * Create a new ecosystem repo.
 * @param {string} name
 * @param {string} description
 * @param {string} authorName
 * @param {string} authorEmail
 * @returns {object} { name, headSha }
 */
async function createEcosystem(name, description, authorName, authorEmail) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid ecosystem name '${name}': use lowercase letters, digits and hyphens`);
  }

  const dir = ecoPath(name);
  if (fs.existsSync(dir)) throw new Error(`Ecosystem '${name}' already exists`);

  await fsP.mkdir(dir, { recursive: true });
  await fsP.mkdir(path.join(dir, 'contracts'), { recursive: true });
  await fsP.mkdir(path.join(dir, 'services'), { recursive: true });

  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.name', authorName);
  await git.addConfig('user.email', authorEmail);

  // Determine latest basecamp tag
  const tags = await (simpleGit(BASECAMP_DIR)).tags();
  const latestTag = tags.all.sort().pop() || 'v1.0.0';
  const extendsRef = `everest-basecamp@${latestTag.replace(/^v/, '')}`;

  const YAML = require('yaml');
  const ecosystemYaml = YAML.stringify({
    ecosystem: name,
    extends: extendsRef,
    description: description || '',
    domains: {},
    profiles: {
      dev: { mocks: true, replicas: 1 },
      prod: { mocks: false, replicas: 2 },
    },
  });

  await fsP.writeFile(path.join(dir, 'ecosystem.yaml'), ecosystemYaml);
  await fsP.writeFile(path.join(dir, 'contracts', 'events.yaml'), '{}\n');
  await fsP.writeFile(path.join(dir, 'contracts', 'commands.yaml'), '{}\n');
  await fsP.writeFile(path.join(dir, 'contracts', 'types.yaml'), '{}\n');

  await git.add('.');
  await git.commit(`Create ecosystem '${name}'`);

  const log = await git.log({ maxCount: 1 });
  return { name, headSha: log.latest.hash };
}

// ─── File reads ───────────────────────────────────────────────────────────────

/**
 * Read all authored files at a ref (default HEAD).
 */
async function readEcosystemFiles(name, ref = 'HEAD') {
  const git = ecoGit(name);
  try {
    const lsTree = await git.raw(['ls-tree', '-r', '--name-only', ref]);
    const filePaths = lsTree.trim().split('\n').filter(Boolean);
    const files = {};
    for (const fp of filePaths) {
      files[fp] = await git.show([`${ref}:${fp}`]);
    }
    return files;
  } catch (e) {
    throw new Error(`Cannot read ecosystem '${name}' at '${ref}': ${e.message}`);
  }
}

// ─── Resolve helpers ──────────────────────────────────────────────────────────

async function loadAndResolve(name, ref = 'HEAD', profile = null) {
  const ecoFiles = await readEcosystemFiles(name, ref);
  const YAML = require('yaml');
  const meta = YAML.parse(ecoFiles['ecosystem.yaml'] || '{}');
  const basecampTag = await resolveBasecampTag(meta.extends || 'everest-basecamp@1.0');
  const bcFiles = await readBasecampAtTag(basecampTag);

  const bc = loadBasecamp(bcFiles);
  const eco = loadEcosystem(ecoFiles);
  const resolved = resolve(bc, eco, { profile });
  const violations = check(bc, eco, resolved);

  return { bc, eco, resolved, violations };
}

// ─── Write a single file (with validation + commit) ──────────────────────────

/**
 * Write one file to an ecosystem and commit.
 * @param {string}  name          Ecosystem name
 * @param {string}  filePath      e.g. "services/order-service.yaml"
 * @param {string}  content       New file content (null to delete)
 * @param {object}  author        { name, email }
 * @param {string}  commitMessage
 * @param {string}  userPrompt    Appended to commit message
 * @returns {{ sha, summary, files, errors, violations }}
 */
async function writeEcosystemFile(name, filePath, content, author, commitMessage, userPrompt = '') {
  if (!isValidPath(filePath)) {
    throw new Error(`Path '${filePath}' is not allowed. Must match ecosystem.yaml, contracts/*.yaml or services/*.yaml`);
  }

  return withEcosystemLock(name, async () => {
    const dir = ecoPath(name);
    const git = ecoGit(name);
    await git.addConfig('user.name', author.name);
    await git.addConfig('user.email', author.email);

    const fullPath = path.join(dir, filePath);
    const isDelete = content === null;

    // Stage the change on a scratch copy (in-memory: just validate before writing)
    const currentFiles = await readEcosystemFiles(name, 'HEAD');
    const scratch = { ...currentFiles };
    if (isDelete) {
      delete scratch[filePath];
    } else {
      scratch[filePath] = content;
    }

    // Parse + schema validate only — rule violations don't block commit
    const errors = [];
    try {
      const YAML = require('yaml');
      const meta = YAML.parse(scratch['ecosystem.yaml'] || '{}');
      const basecampTag = await resolveBasecampTag(meta.extends || 'everest-basecamp@1.0');
      const bcFiles = await readBasecampAtTag(basecampTag);
      const bc = loadBasecamp(bcFiles);
      const eco = loadEcosystem(scratch);
      const resolved = resolve(bc, eco);
      const violations = check(bc, eco, resolved);
      // Commit even with rule violations (they're work-in-progress)
      // Return violations so caller can show them
      const msg = userPrompt ? `${commitMessage}\n\n${userPrompt}` : commitMessage;

      if (isDelete) {
        await fsP.unlink(fullPath).catch(() => {});
        await git.rm([filePath]);
      } else {
        await fsP.mkdir(path.dirname(fullPath), { recursive: true });
        await fsP.writeFile(fullPath, content);
        await git.add([filePath]);
      }
      await git.commit(msg);
      const log = await git.log({ maxCount: 1 });
      return {
        sha: log.latest.hash,
        summary: log.latest.message.split('\n')[0],
        files: [filePath],
        errors: [],
        violations,
      };
    } catch (e) {
      // Schema/parse error: don't commit
      errors.push(e.message);
      return { errors, violations: [] };
    }
  });
}

/**
 * Apply a set of patch operations (from chat) atomically.
 * @param {string} name
 * @param {Array<{path: string, content: string|null}>} patches
 * @param {object} author
 * @param {string} commitMessage
 * @param {string} userPrompt
 */
async function applyPatches(name, patches, author, commitMessage, userPrompt = '') {
  return withEcosystemLock(name, async () => {
    const dir = ecoPath(name);
    const git = ecoGit(name);
    await git.addConfig('user.name', author.name);
    await git.addConfig('user.email', author.email);

    // Validate paths
    for (const p of patches) {
      if (!isValidPath(p.path)) {
        return { errors: [`Path '${p.path}' is not allowed`], violations: [] };
      }
    }

    // Build scratch from current HEAD + patches
    const currentFiles = await readEcosystemFiles(name, 'HEAD');
    const scratch = { ...currentFiles };
    for (const p of patches) {
      if (p.content === null) delete scratch[p.path];
      else scratch[p.path] = p.content;
    }

    // Parse + schema validate
    const errors = [];
    let violations = [];
    let bc, eco, resolved;
    try {
      const YAML = require('yaml');
      const meta = YAML.parse(scratch['ecosystem.yaml'] || '{}');
      const basecampTag = await resolveBasecampTag(meta.extends || 'everest-basecamp@1.0');
      const bcFiles = await readBasecampAtTag(basecampTag);
      bc = loadBasecamp(bcFiles);
      eco = loadEcosystem(scratch);
      resolved = resolve(bc, eco);
      violations = check(bc, eco, resolved);
    } catch (e) {
      errors.push(e.message);
      return { errors, violations: [] };
    }

    // Apply patches to filesystem
    const changedFiles = [];
    for (const p of patches) {
      const fullPath = path.join(dir, p.path);
      if (p.content === null) {
        await fsP.unlink(fullPath).catch(() => {});
        await git.rm([p.path]).catch(() => {});
      } else {
        await fsP.mkdir(path.dirname(fullPath), { recursive: true });
        await fsP.writeFile(fullPath, p.content);
        await git.add([p.path]);
      }
      changedFiles.push(p.path);
    }

    const msg = userPrompt ? `${commitMessage}\n\n${userPrompt}` : commitMessage;
    await git.commit(msg);
    const log = await git.log({ maxCount: 1 });

    return {
      sha: log.latest.hash,
      summary: log.latest.message.split('\n')[0],
      files: changedFiles,
      errors: [],
      violations,
    };
  });
}

// ─── History ──────────────────────────────────────────────────────────────────

async function getHistory(name) {
  const git = ecoGit(name);
  const log = await git.log();
  return log.all.map(entry => ({
    sha: entry.hash,
    date: entry.date,
    authorName: entry.author_name,
    authorEmail: entry.author_email,
    summary: entry.message,
  }));
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

async function getDiff(name, from, to = 'HEAD') {
  const git = ecoGit(name);

  // Raw file diff
  const rawDiff = await git.diff([`${from}..${to}`, '--stat']);
  const fullDiff = await git.diff([`${from}..${to}`]);

  // Resolved diff
  const [beforeResult, afterResult] = await Promise.all([
    loadAndResolve(name, from).catch(() => null),
    loadAndResolve(name, to).catch(() => null),
  ]);

  const resolvedDiff = computeResolvedDiff(beforeResult, afterResult);

  return { rawDiff: fullDiff, stat: rawDiff, resolvedDiff };
}

function computeResolvedDiff(before, after) {
  if (!before || !after) return null;

  const changes = [];
  const bServices = before.eco.services;
  const aServices = after.eco.services;
  const allIds = new Set([...Object.keys(bServices), ...Object.keys(aServices)]);

  for (const id of allIds) {
    if (!bServices[id]) {
      changes.push({ type: 'service_added', service: id });
      continue;
    }
    if (!aServices[id]) {
      changes.push({ type: 'service_removed', service: id });
      continue;
    }

    // Check endpoints
    const bApi = bServices[id].api?.rest || {};
    const aApi = aServices[id].api?.rest || {};
    for (const ep of Object.keys(bApi)) {
      if (!aApi[ep]) changes.push({ type: 'endpoint_removed', service: id, endpoint: ep });
    }
    for (const ep of Object.keys(aApi)) {
      if (!bApi[ep]) changes.push({ type: 'endpoint_added', service: id, endpoint: ep });
    }

    // Check events
    const bPub = bServices[id].publishes || [];
    const aPub = aServices[id].publishes || [];
    for (const ev of bPub) {
      if (!aPub.includes(ev)) changes.push({ type: 'event_removed', service: id, event: ev });
    }
    for (const ev of aPub) {
      if (!bPub.includes(ev)) changes.push({ type: 'event_added', service: id, event: ev });
    }
  }

  // Suggest version bump
  const hasBreaking = changes.some(c =>
    c.type === 'service_removed' || c.type === 'endpoint_removed' || c.type === 'event_removed');
  const hasAdditions = changes.some(c =>
    c.type === 'service_added' || c.type === 'endpoint_added' || c.type === 'event_added');
  const suggestedBump = hasBreaking ? 'major' : hasAdditions ? 'minor' : 'patch';

  return { changes, suggestedBump };
}

// ─── Undo ─────────────────────────────────────────────────────────────────────

async function undoHead(name, author) {
  return withEcosystemLock(name, async () => {
    const git = ecoGit(name);
    await git.addConfig('user.name', author.name);
    await git.addConfig('user.email', author.email);

    // Refuse if HEAD is tagged
    const log = await git.log({ maxCount: 1 });
    const headSha = log.latest.hash;
    const tags = await git.tags();
    const taggedShas = [];
    for (const tag of tags.all) {
      try {
        const sha = (await git.raw(['rev-list', '-n', '1', tag])).trim();
        taggedShas.push(sha);
      } catch (_) {}
    }
    if (taggedShas.includes(headSha)) {
      throw new Error(`Cannot undo a tagged commit (${headSha.slice(0, 7)}). Tags are immutable.`);
    }

    await git.revert(['HEAD', '--no-edit']);
    const newLog = await git.log({ maxCount: 1 });
    return { sha: newLog.latest.hash, summary: newLog.latest.message.split('\n')[0] };
  });
}

// ─── Versions (tags) ─────────────────────────────────────────────────────────

async function listVersions(name) {
  const git = ecoGit(name);
  const tags = await git.tags();
  const versions = [];

  for (const tag of tags.all.filter(t => /^v\d/.test(t))) {
    try {
      const info = await git.raw(['for-each-ref', `refs/tags/${tag}`,
        '--format=%(objectname:short) %(taggerdate:iso) %(contents)']);
      const [first, ...rest] = info.trim().split('\n');
      const [sha, ...dateParts] = first.split(' ');
      versions.push({ tag, sha, date: dateParts.join(' '), notes: rest.join('\n').trim() });
    } catch (_) {
      versions.push({ tag });
    }
  }
  return versions;
}

/**
 * Publish a new version tag.
 * @param {string} name
 * @param {'major'|'minor'|'patch'} bump
 * @param {string} notes
 * @param {object} author
 * @returns {{ tag }}
 */
async function publishVersion(name, bump, notes, author) {
  return withEcosystemLock(name, async () => {
    // Check for blocking violations
    const { bc, eco, resolved, violations } = await loadAndResolve(name, 'HEAD');
    const blocking = violations.filter(v => v.severity === 'error');
    if (blocking.length > 0) {
      const msgs = blocking.map(v => `[${v.ruleId}] ${v.service}: ${v.message}`).join('\n');
      throw Object.assign(new Error('Cannot publish: blocking violations exist'), { violations: blocking, statusCode: 409 });
    }

    const git = ecoGit(name);
    const existingTags = await git.tags();
    const semverTags = existingTags.all.filter(t => /^v\d/.test(t)).sort();

    let major = 0, minor = 0, patch = 0;
    if (semverTags.length > 0) {
      const last = semverTags.pop().replace(/^v/, '');
      [major, minor, patch] = last.split('.').map(Number);
    }

    if (bump === 'major') { major++; minor = 0; patch = 0; }
    else if (bump === 'minor') { minor++; patch = 0; }
    else { patch++; }

    const tag = `v${major}.${minor}.${patch}`;
    await git.addAnnotatedTag(tag, notes || `Release ${tag}`);
    return { tag };
  });
}

/**
 * Suggest a version bump by comparing HEAD to the last tag.
 */
async function suggestVersionBump(name) {
  const git = ecoGit(name);
  const tags = await git.tags();
  const semverTags = tags.all.filter(t => /^v\d/.test(t)).sort();

  if (semverTags.length === 0) return 'minor'; // first release

  const lastTag = semverTags.pop();
  const diff = await getDiff(name, lastTag, 'HEAD');
  return diff.resolvedDiff?.suggestedBump || 'patch';
}

module.exports = {
  ensureBasecamp,
  basecampVersions,
  readBasecampAtTag,
  resolveBasecampTag,
  listEcosystems,
  createEcosystem,
  readEcosystemFiles,
  loadAndResolve,
  writeEcosystemFile,
  applyPatches,
  getHistory,
  getDiff,
  undoHead,
  listVersions,
  publishVersion,
  suggestVersionBump,
  ecoPath,
};
