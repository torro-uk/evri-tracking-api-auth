import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvriClient } from '../src/evri.js';
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const credentials = { apiKey: 'test-api', clientId: 'test-auth-id', clientSecret: 'test-secret' };

test('gets OAuth token and returns events newest first', async () => {
  const calls = [];
  const client = createEvriClient({ ...credentials, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('oauth')) return jsonResponse({ access_token: 'abc', expires_in: 86400 });
    return jsonResponse([{ dateTime: '2026-10-20T12:00:00Z', trackingPoint: { description: 'At depot', trackingPointId: '1' } }, { dateTime: '2026-10-21T12:00:00Z', trackingPoint: { description: 'Delivered', trackingPointId: '2' } }]);
  } });
  const data = await client.tracking('H-00IM-A-000000001-0');
  assert.equal(data.trackingId, 'H00IMA0000000010');
  assert.equal(data.latestEvent.description, 'Delivered');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.apikey, 'test-api');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer abc');
  assert.match(calls[1].url, /descriptionType=CLIENT/);
});

test('cached token reused across tracking requests', async () => {
  let authCalls = 0;
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) => {
    if (String(url).includes('oauth')) { authCalls++; return jsonResponse({ access_token: 'abc', expires_in: 86400 }); }
    return jsonResponse([]);
  } });
  await client.tracking('H00IMA0000000010');
  await client.tracking('H00IMA0000000010');
  assert.equal(authCalls, 1);
});

test('rejects invalid tracking number without network', async () => {
  const client = createEvriClient({ ...credentials, fetchImpl: async () => { throw new Error('unexpected'); } });
  await assert.rejects(() => client.tracking('INVALID'), { code: 'INVALID_BARCODE' });
});

test('ETA failure does not remove tracking events', async () => {
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) => {
    if (String(url).includes('oauth')) return jsonResponse({ access_token: 'abc', expires_in: 3600 });
    if (String(url).includes('/etas')) return jsonResponse({ error: 'disabled' }, 403);
    return jsonResponse([{ dateTime: '2026-10-21T12:00:00Z', trackingPoint: { description: 'At hub' } }]);
  } });
  const data = await client.tracking('H00IMA0000000010', true);
  assert.equal(data.events.length, 1);
  assert.equal(data.etaError.code, 'EVRI_HTTP_403');
});


test('OAuth failure identifies stage and status without leaking body', async () => {
  const client = createEvriClient({ ...credentials, fetchImpl: async () => jsonResponse({ error: 'invalid_client', detail: 'SECRET_STAYS_PRIVATE' }, 401) });
  await assert.rejects(() => client.tracking('H00IMA0000000010'), (err) => {
    assert.equal(err.stage, 'oauth');
    assert.equal(err.httpStatus, 401);
    assert.equal(err.upstreamCode, 'invalid_client');
    assert.doesNotMatch(err.message, /SECRET_STAYS_PRIVATE/);
    return true;
  });
});

test('Tracking failure identifies stage after successful OAuth', async () => {
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) =>
    String(url).includes('oauth') ? jsonResponse({ access_token: 'abc', expires_in: 86400 }) : jsonResponse({ error: 'forbidden' }, 403)
  });
  await assert.rejects(() => client.tracking('H00IMA0000000010'), (err) => {
    assert.equal(err.stage, 'tracking');
    assert.equal(err.httpStatus, 403);
    return true;
  });
});

test('dedicated ETA retrieves documented endpoint with cached token', async () => {
  const calls = [];
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).includes('oauth')) return jsonResponse({ access_token: 'abc', expires_in: 86400 });
    return jsonResponse({ displayString: 'Between 10am and noon', type: 'DELIVERY' });
  } });
  const res = await client.eta('H00IMA0000000010');
  assert.equal(res.eta.type, 'DELIVERY');
  assert.match(calls[1], /client-tracking\/v1\/etas\?barcode=H00IMA0000000010/);
});

test('safe-place photo returns image content with correct endpoint and reuses OAuth token', async () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');
  const calls = [];
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).includes('oauth')) return jsonResponse({ access_token: 'abc', expires_in: 86400 });
    return jsonResponse({ base64EncodedBytes: png, imageFormat: 'PNG' });
  } });
  const result = await client.safePlacePhoto('H00IMA0000000010');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.base64, png);
  assert.match(calls[1], /safe-place-photos\?barcode=H00IMA0000000010/);
  await client.safePlacePhoto('H00IMA0000000010');
  assert.equal(calls.filter(x => x.includes('oauth')).length, 1);
});

test('signature returns JPEG content and optional printed name', async () => {
  const jpeg = Buffer.from([255,216,255,224,0,16]).toString('base64');
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) =>
    String(url).includes('oauth') ? jsonResponse({ access_token: 'abc', expires_in: 86400 }) : jsonResponse({ imageFormat: 'JPEG', base64EncodedBytes: jpeg, printedName: 'Test Person' })
  });
  const result = await client.signature('H00IMA0000000010');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.printedName, 'Test Person');
});

test('missing proof image fails without leaking upstream payload', async () => {
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) =>
    String(url).includes('oauth') ? jsonResponse({ access_token: 'abc', expires_in: 86400 }) : jsonResponse({ imageFormat: 'PNG' })
  });
  await assert.rejects(() => client.safePlacePhoto('H00IMA0000000010'), { code: 'PROOF_UNAVAILABLE' });
});

test('mismatched or oversized image data rejected', async () => {
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) =>
    String(url).includes('oauth') ? jsonResponse({ access_token: 'abc', expires_in: 86400 }) : jsonResponse({ imageFormat: 'PNG', base64EncodedBytes: Buffer.from('NOTPNG').toString('base64') })
  });
  await assert.rejects(() => client.safePlacePhoto('H00IMA0000000010'), { code: 'INVALID_IMAGE_DATA' });
});

test('proof endpoint 403 reports stage and status', async () => {
  const client = createEvriClient({ ...credentials, fetchImpl: async (url) =>
    String(url).includes('oauth') ? jsonResponse({ access_token: 'abc', expires_in: 86400 }) : jsonResponse({ error: 'forbidden' }, 403)
  });
  await assert.rejects(() => client.signature('H00IMA0000000010'), (e) => e.stage === 'signature' && e.httpStatus === 403);
});
