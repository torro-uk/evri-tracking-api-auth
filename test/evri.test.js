import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EvriClient, validateBarcode } from '../src/services/evri-api.js';
import { parseProofResponse } from '../src/services/proof.js';
import { debugEvriProofResponse } from '../src/services/evri-proof-debug.js';
import { proofContent } from '../src/tools/content.js';
import { loadConfig } from '../src/config.js';

const ID = 'H04B9A0000663089';
const CONFIG = { apiKey: 'mock-api-key', clientId: 'mock-client-id', clientSecret: 'mock-secret', oauthUrl: 'https://oauth.example.test/', apiBaseUrl: 'https://api.example.test' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxv0AAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG, 'base64');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const proof = (extra = {}) => ({ base64EncodedBytes: PNG, imageFormat: 'PNG', ...extra });
const bytes = value => Buffer.from(JSON.stringify(value));
function mock(handler, extra = {}) {
  const calls = [];
  let tokenCount = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (new URL(url).origin === new URL(CONFIG.oauthUrl).origin) {
      tokenCount++;
      return json({ access_token: `token-${tokenCount}`, expires_in: 86400, token_type: 'Bearer' });
    }
    return handler(new URL(url), init, calls);
  };
  return { calls, client: new EvriClient(CONFIG, { fetchImpl, ...extra }), tokenCount: () => tokenCount };
}

test('configuration uses reference URLs and exact Clerk resource', () => {
  const config = loadConfig({ EVRI_API_KEY: 'key', EVRI_CLIENT_ID: 'id', EVRI_CLIENT_SECRET: 'secret', CLERK_PUBLISHABLE_KEY: 'pk', CLERK_SECRET_KEY: 'sk', MCP_RESOURCE_URL: 'https://service.example.test/mcp', NODE_ENV: 'production' });
  assert.equal(config.evri.oauthUrl, 'https://oauth.prod.evricloud.co.uk/');
  assert.equal(config.evri.apiBaseUrl, 'https://api.evri.com');
  assert.equal(config.resourceUrl, 'https://service.example.test/mcp');
  assert.throws(() => loadConfig({}), /Missing environment variables/);
});

test('validates barcode and normalizes case', () => {
  assert.equal(validateBarcode(` ${ID.toLowerCase()} `), ID);
  for (const bad of ['', 'a', 'foo?barcode=evil', null]) assert.throws(() => validateBarcode(bad), { code: 'INVALID_TRACKING_ID' });
});

test('tracking uses documented endpoint, headers, OAuth request and normalized event fields', async () => {
  const { client, calls } = mock(() => json([
    { dateTime: '2026-10-21T11:25:27Z', trackingPoint: { description: 'Details received', trackingPointId: '1012' } },
    { dateTime: '2026-10-22T16:52:27Z', trackingPoint: { description: 'Delivered to letterbox', trackingPointId: '1266' }, location: { latitude: 51.5, longitude: -0.44 }, links: [{ rel: 'safe-place-photos', href: '/foo' }] }
  ]));
  const result = await client.getTracking(ID);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { grant_type: 'client_credentials', client_id: CONFIG.clientId, client_secret: CONFIG.clientSecret, audience: 'client-tracking-api' });
  assert.equal(calls[1].url.pathname, '/client-tracking/v1/events');
  assert.equal(calls[1].url.searchParams.get('barcode'), ID);
  assert.equal(calls[1].url.searchParams.get('descriptionType'), 'CLIENT');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer token-1');
  assert.equal(calls[1].init.headers.apikey, CONFIG.apiKey);
  assert.equal(result.latestEvent.trackingPointId, '1266');
  assert.deepEqual(result.latestEvent.availableResources, ['safe-place-photos']);
  assert.deepEqual(result.latestEvent.location, { latitude: 51.5, longitude: -0.44 });
  assert.equal(result.events.length, 2);
});

test('concurrent calls share the cached Evri OAuth token', async () => {
  const { client, tokenCount } = mock(() => json([]));
  await Promise.all([client.getTracking(ID), client.getTracking(ID), client.getEta(ID)]);
  assert.equal(tokenCount(), 1);
});

test('tracking keeps successful events when optional ETA fails', async () => {
  const { client } = mock(url => url.pathname.endsWith('/etas') ? json({}, 403) : json([{ dateTime: '2026-10-22T16:52:27Z' }]));
  const result = await client.getTracking(ID, true);
  assert.equal(result.eventsAvailable, true);
  assert.equal(result.eta_error.error, 'EVRI_HTTP_403');
  assert.equal(result.eta_error.stage, 'etas');
});

test('ETA uses /etas and does not send descriptionType', async () => {
  const { client, calls } = mock(() => json({ displayString: '10:00-12:00', type: 'DELIVERY' }));
  const result = await client.getEta(ID);
  assert.equal(calls[1].url.pathname, '/client-tracking/v1/etas');
  assert.equal(calls[1].url.searchParams.has('descriptionType'), false);
  assert.equal(result.eta.type, 'DELIVERY');
});

test('photo uses safe-place-photos and outputs native MCP image content', async () => {
  const { client, calls } = mock(() => json(proof()));
  const result = await client.getProof(ID, 'safe-place-photos');
  assert.equal(calls[1].url.pathname, '/client-tracking/v1/safe-place-photos');
  assert.equal(calls[1].url.searchParams.get('barcode'), ID);
  assert.equal(calls[1].url.searchParams.has('descriptionType'), false);
  assert.equal(calls[1].init.headers.Accept, 'application/json');
  assert.equal(result.images[0].mimeType, 'image/png');
  const content = proofContent(result).content;
  assert.deepEqual(content[1], { type: 'image', data: PNG, mimeType: 'image/png' });
  assert.ok(!content[0].text.includes(PNG));
});

test('signature uses signatures and preserves optional printedName', async () => {
  const { client, calls } = mock(() => json(proof({ printedName: 'Test name' })));
  const result = await client.getProof(ID, 'signatures');
  assert.equal(calls[1].url.pathname, '/client-tracking/v1/signatures');
  assert.equal(result.images[0].printedName, 'Test name');
  assert.equal(JSON.parse(proofContent(result).content[0].text).images[0].printedName, 'Test name');
});

test('canonical image fields also work in arrays and known wrapper objects', () => {
  assert.equal(parseProofResponse(bytes({ data: { photos: [proof(), proof()] } }), 'safe-place-photos').length, 1);
  assert.equal(parseProofResponse(bytes([proof()]), 'safe-place-photos')[0].data, PNG);
});

test('binary image fallback and declared MIME mismatch are handled', () => {
  assert.equal(parseProofResponse(PNG_BYTES, 'safe-place-photos')[0].data, PNG);
  const result = parseProofResponse(bytes(proof({ imageFormat: 'JPG' })), 'safe-place-photos')[0];
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.declaredImageFormat, 'JPEG');
});

test('JPEG declared as JPG gets image/jpeg', () => {
  // Synthetic header fixture tests identification, not full image decoding.
  const jpegHeader = Buffer.from('ffd8ffe000104a46494600', 'hex').toString('base64');
  const result = parseProofResponse(bytes({ base64EncodedBytes: jpegHeader, imageFormat: 'JPG' }), 'signatures')[0];
  assert.equal(result.mimeType, 'image/jpeg');
});

test('empty, missing, invalid image, malformed JSON have distinct errors', () => {
  for (const data of [Buffer.alloc(0), bytes({ base64EncodedBytes: '' }), bytes({ image: PNG }), bytes({ data: [] })]) {
    assert.throws(() => parseProofResponse(data, 'safe-place-photos'), { code: 'PROOF_UNAVAILABLE' });
  }
  for (const data of [bytes(proof({ base64EncodedBytes: 'bad base64!' })), bytes(proof({ base64EncodedBytes: Buffer.from('not an image').toString('base64') }))]) {
    assert.throws(() => parseProofResponse(data, 'safe-place-photos'), { code: 'PROOF_INVALID_IMAGE' });
  }
  assert.throws(() => parseProofResponse(Buffer.from('<html>not JSON</html>'), 'safe-place-photos'), { code: 'PROOF_INVALID_RESPONSE' });
});

test('403 and 404 are returned as upstream HTTP failures, not proof parser errors', async () => {
  for (const status of [403, 404]) {
    const { client } = mock(() => json({ error: 'private upstream details' }, status));
    await assert.rejects(client.getProof(ID, 'safe-place-photos'), { code: `EVRI_HTTP_${status}`, status, stage: 'safe-place-photos' });
  }
});

test('401 refreshes OAuth once then retries with new token', async () => {
  const { client, tokenCount } = mock((_url, init) => init.headers.Authorization === 'Bearer token-1' ? json({}, 401) : json(proof()));
  const result = await client.getProof(ID, 'safe-place-photos');
  assert.equal(result.images[0].data, PNG);
  assert.equal(tokenCount(), 2);
});

test('persistent 401 does not retry indefinitely', async () => {
  const { client, tokenCount } = mock(() => json({}, 401));
  await assert.rejects(client.getTracking(ID), { code: 'EVRI_HTTP_401', stage: 'events' });
  assert.equal(tokenCount(), 2);
});

test('OAuth failures are labelled separately and no tracking is attempted', async () => {
  let count = 0;
  const client = new EvriClient(CONFIG, { fetchImpl: async () => { count++; return json({ error: 'access_denied' }, 401); } });
  await assert.rejects(client.getProof(ID, 'safe-place-photos'), { code: 'EVRI_HTTP_401', stage: 'oauth', upstreamCode: 'access_denied' });
  assert.equal(count, 1);
});

test('diagnostics are called before parsing even on HTTP errors, including signatures', async () => {
  const logs = [];
  const { client } = mock(() => json({ error: 'forbidden' }, 403), { debug: async (res, resource, body) => logs.push({ status: res.status, resource, bodyLength: body.length }) });
  await assert.rejects(client.getProof(ID, 'safe-place-photos'));
  await assert.rejects(client.getProof(ID, 'signatures'));
  assert.deepEqual(logs.map(x => [x.status, x.resource]), [[403, 'safe-place-photos'], [403, 'signatures']]);
  assert.ok(logs.every(x => x.bodyLength > 0));
});

test('diagnostics are opt-in, preserve response and never log body values or unknown keys', async () => {
  const old = process.env.EVRI_DEBUG_PROOF;
  try {
    const logs = [];
    const capture = (...args) => logs.push(args.join(' '));
    const response = json({ data: { photos: [proof({ printedName: 'Private Name', links: [{ href: 'https://private.example.test' }], secret_customer_key: 'private secret' })] } });
    delete process.env.EVRI_DEBUG_PROOF;
    await debugEvriProofResponse(response, 'safe-place-photos', undefined, capture);
    assert.equal(logs.length, 0);
    process.env.EVRI_DEBUG_PROOF = 'true';
    await debugEvriProofResponse(response, 'safe-place-photos', undefined, capture);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /EVRI_PROOF_DEBUG/);
    assert.match(logs[0], /base64EncodedBytes/);
    assert.match(logs[0], /PNG/);
    for (const sensitive of [PNG, 'Private Name', 'private.example.test', 'secret_customer_key', 'private secret']) assert.ok(!logs[0].includes(sensitive));
    assert.equal((await response.json()).data.photos[0].base64EncodedBytes, PNG);
  } finally { if (old === undefined) delete process.env.EVRI_DEBUG_PROOF; else process.env.EVRI_DEBUG_PROOF = old; }
});

test('debug identifies binary and empty proof responses without logging bytes', async () => {
  const old = process.env.EVRI_DEBUG_PROOF;
  try {
    process.env.EVRI_DEBUG_PROOF = 'true';
    const logs = [];
    const capture = (_, record) => logs.push(JSON.parse(record));
    await debugEvriProofResponse(new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/png' } }), 'safe-place-photos', PNG_BYTES, capture);
    await debugEvriProofResponse(new Response(null, { status: 204 }), 'safe-place-photos', Buffer.alloc(0), capture);
    assert.equal(logs[0].bodyKind, 'binary-image');
    assert.equal(logs[0].detectedImageFormat, 'PNG');
    assert.equal(logs[1].bodyKind, 'empty');
  } finally { if (old === undefined) delete process.env.EVRI_DEBUG_PROOF; else process.env.EVRI_DEBUG_PROOF = old; }
});
