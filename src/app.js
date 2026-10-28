'use strict';

const express = require('express');
const cors = require('cors');
const { auth } = require('express-oauth2-jwt-bearer');
const { connect } = require('./db');
const { ensureBasecamp, basecampVersions, readBasecampAtTag } = require('./gitStore');
const userRouter = require('./routes/user');
const ecosystemsRouter = require('./routes/ecosystems');
const messagesRouter = require('./routes/messages');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'https://everest.kamradtfamily.net' }));
app.use(express.json({ limit: '2mb' }));

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));

// ─── Auth middleware ──────────────────────────────────────────────────────────

const checkJwt = auth({
  audience: process.env.KEYCLOAK_AUDIENCE,
  issuerBaseURL: process.env.KEYCLOAK_ISSUER_BASE_URL,
});

// ─── Request logging ──────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const userId = req.auth?.payload?.sub || '-';
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms user=${userId}`);
  });
  next();
});

// ─── API routes ───────────────────────────────────────────────────────────────

app.use('/api/user', checkJwt, userRouter);
app.use('/api/ecosystems', checkJwt, ecosystemsRouter);

app.get('/api/basecamp', checkJwt, async (req, res) => {
  try {
    const versions = await basecampVersions();
    const requestedTag = req.query.tag;
    if (requestedTag) {
      const files = await readBasecampAtTag(requestedTag);
      return res.json({ versions, tag: requestedTag, files });
    }
    res.json({ versions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  if (err.status === 401 || err.code === 'invalid_token') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

async function start() {
  try {
    await connect();
    await ensureBasecamp();
    app.listen(PORT, () => console.log(`everest-api listening on :${PORT}`));
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }
}

start();

module.exports = app; // for tests
