#!/usr/bin/env node
'use strict';

/**
 * In-cluster smoke tests for everest-api.
 * Run after deployment; requires a valid Cloudflare Access service token.
 *
 * env vars:
 *   SMOKE_BASE_URL              https://everest-api.kamradtfamily.net
 *   CF_ACCESS_CLIENT_ID         Cloudflare Access service token id
 *   CF_ACCESS_CLIENT_SECRET     Cloudflare Access service token secret
 *   SMOKE_JWT                   Optional JWT (skip if CF Access provides token)
 */

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:8080';

async function req(path, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.CF_ACCESS_CLIENT_ID) {
    headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

let passed = 0, failed = 0;

function ok(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log(`Smoke tests → ${BASE}\n`);

  // Health
  console.log('Health');
  const health = await req('/health');
  ok('GET /health returns 200', health.status === 200, JSON.stringify(health.body));

  // Skip auth-required endpoints if no token
  const token = process.env.SMOKE_JWT;
  if (!token) {
    console.log('\nNo SMOKE_JWT set — skipping authenticated endpoint tests');
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    return;
  }

  // List ecosystems
  console.log('\nEcosystems');
  const list = await req('/api/ecosystems', 'GET', null, token);
  ok('GET /api/ecosystems returns 200', list.status === 200);

  // Create ecosystem
  const ecoName = `smoke-${Date.now()}`;
  const created = await req('/api/ecosystems', 'POST', { name: ecoName, description: 'Smoke test ecosystem' }, token);
  ok('POST /api/ecosystems creates ecosystem', created.status === 201, JSON.stringify(created.body));

  // Write a service file
  const svcContent = `service: smoke-service\narchetype: http\ndomain: test\npurpose: Smoke test service\n`;
  const ecoContent = `ecosystem: ${ecoName}\nextends: everest-basecamp@1.0\ndescription: Smoke test\ndomains:\n  test: Test domain\nprofiles:\n  dev:\n    mocks: true\n    replicas: 1\n  prod:\n    mocks: false\n    replicas: 2\n`;

  const w1 = await req(`/api/ecosystems/${ecoName}/files/ecosystem.yaml`, 'PUT', { content: ecoContent }, token);
  ok('PUT ecosystem.yaml', w1.status === 200, JSON.stringify(w1.body));

  const w2 = await req(`/api/ecosystems/${ecoName}/files/services/smoke-service.yaml`, 'PUT', { content: svcContent }, token);
  ok('PUT services/smoke-service.yaml', w2.status === 200, JSON.stringify(w2.body));

  // Read effective
  const eff = await req(`/api/ecosystems/${ecoName}/effective/smoke-service`, 'GET', null, token);
  ok('GET effective/:service returns 200', eff.status === 200);
  ok('Effective spec has runtime', eff.body?.runtime?.port != null, JSON.stringify(eff.body?.runtime));

  // Violations
  const viol = await req(`/api/ecosystems/${ecoName}/violations`, 'GET', null, token);
  ok('GET violations returns 200', viol.status === 200);

  // History
  const hist = await req(`/api/ecosystems/${ecoName}/history`, 'GET', null, token);
  ok('GET history returns 200', hist.status === 200);
  ok('History has commits', Array.isArray(hist.body) && hist.body.length >= 2, `length=${hist.body?.length}`);

  // Versions
  const vers = await req(`/api/ecosystems/${ecoName}/versions`, 'GET', null, token);
  ok('GET versions returns 200', vers.status === 200);
  ok('Versions has suggestedBump', vers.body?.suggestedBump != null);

  // Publish
  const pub = await req(`/api/ecosystems/${ecoName}/versions`, 'POST', { bump: 'minor', notes: 'Smoke test release' }, token);
  ok('POST versions publishes', pub.status === 201, JSON.stringify(pub.body));

  const vers2 = await req(`/api/ecosystems/${ecoName}/versions`, 'GET', null, token);
  ok('Versions list includes new tag', vers2.body?.versions?.some(v => /^v/.test(v.tag)));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
