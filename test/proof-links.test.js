import test from 'node:test';
import assert from 'node:assert/strict';
import { createProofLinks, resolveProofLink, proofLinkHandler } from '../src/services/proof-links.js';
import { proofContent } from '../src/tools/content.js';
import { loadConfig } from '../src/config.js';
const config = { origin: 'https://service.example.test', secret: 'ab'.repeat(32), ttlSeconds: 300 };
const image = { data: 'iVBORw0KGgo=', mimeType: 'image/png', imageFormat: 'PNG' };
const result = { trackingId: 'H04B9A0000663089', resource: 'safe-place-photos', images: [image] };
const tokenOf = link => new URL(link.imageUrl).pathname.split('/').pop();
const clock = 1800000000000;
const make = () => createProofLinks(config, () => clock);
test('native Base64 remains intact and each proof has an opaque HTTPS link', () => {
  const content = proofContent(result, make()).content;
  const metadata = JSON.parse(content[0].text).images[0];
  assert.equal(new URL(metadata.imageUrl).origin, config.origin);
  assert.ok(!metadata.imageUrl.includes(result.trackingId));
  assert.equal(metadata.expiresAt, new Date(clock + 300000).toISOString());
  assert.deepEqual(content[1], { type: 'image', data: image.data, mimeType: image.mimeType });
  assert.equal(metadata.data, undefined);
});
test('disabled links preserve original behavior', () => {
  assert.equal(createProofLinks({ ...config, secret: null }), null);
  assert.equal(JSON.parse(proofContent(result).content[0].text).images[0].imageUrl, undefined);
});
test('valid link resolves to exact original image, including reordered images', async () => {
  const links = make(); const other = { ...image, data: 'YWJj' };
  const out = await resolveProofLink(links, { getProof: async (id, resource) => {
    assert.equal(id, result.trackingId); assert.equal(resource, result.resource);
    return { images: [other, image] };
  } }, tokenOf(links.issue(result, image)));
  assert.deepEqual(out.bytes, Buffer.from(image.data, 'base64')); assert.equal(out.mimeType, image.mimeType);
});
test('tampering, key rotation, expiry and malformed tokens fail closed without upstream request', async () => {
  let time = clock; const links = createProofLinks(config, () => time); const token = tokenOf(links.issue(result, image));
  const changed = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  const evri = { getProof: async () => { throw Error('must not call'); } };
  assert.equal(await resolveProofLink(links, evri, changed), null);
  assert.equal(await resolveProofLink(links, evri, 'bad'), null);
  assert.equal(await resolveProofLink(createProofLinks({...config, secret:'cd'.repeat(32)}, () => time), evri, token), null);
  time += 300000; assert.equal(await resolveProofLink(links, evri, token), null);
});
test('changed image or expiry during upstream fetch cannot disclose evidence', async () => {
  let time = clock; const links = createProofLinks(config, () => time); const token = tokenOf(links.issue(result, image));
  assert.equal(await resolveProofLink(links, { getProof: async () => ({ images: [{ ...image, data: 'YWJj' }] }) }, token), null);
  assert.equal(await resolveProofLink(links, { getProof: async () => { time += 300000; return result; } }, token), null);
});
test('signature link is bound to signature resource', async () => {
  const links = make(); const signature = { ...result, resource: 'signatures' };
  const token = tokenOf(links.issue(signature, image));
  assert.equal(links.verify(token).resource, 'signatures');
  assert.ok(await resolveProofLink(links, { getProof: async (_, r) => { assert.equal(r, 'signatures'); return signature; } }, token));
});
test('config rejects invalid secret or expiry', () => {
  const env = { EVRI_API_KEY: 'x', EVRI_CLIENT_ID: 'x', EVRI_CLIENT_SECRET: 'x', CLERK_PUBLISHABLE_KEY: 'x', CLERK_SECRET_KEY: 'x', MCP_RESOURCE_URL: config.origin + '/mcp' };
  assert.throws(() => loadConfig({ ...env, EVRI_PROOF_LINK_SECRET: 'bad' }), /64 hex/);
  assert.throws(() => loadConfig({ ...env, EVRI_PROOF_LINK_SECRET: config.secret, EVRI_PROOF_LINK_TTL: '301' }), /30-300/);
  assert.equal(loadConfig({ ...env, EVRI_PROOF_LINK_SECRET: config.secret }).proofLinks.ttlSeconds, 300);
});
test('HTTP handler returns image and no-store headers; invalid tokens never fetch', async () => {
  const links = make(); let calls = 0;
  const handler = proofLinkHandler(links, { getProof: async () => { calls++; return result; } });
  const response = () => ({ headers: {}, set(h) { Object.assign(this.headers, h); return this; }, status(s) { this.code = s; return this; }, end(b) { this.body = b; return this; } });
  const res = response(); await handler({method:'GET',params:{token:tokenOf(links.issue(result,image))}}, res);
  assert.equal(res.code,200); assert.equal(res.headers['Content-Type'],'image/png'); assert.match(res.headers['Cache-Control'],/no-store/); assert.deepEqual(res.body,Buffer.from(image.data,'base64'));
  const bad = response(); await handler({method:'GET',params:{token:'bad'}}, bad); assert.equal(bad.code,404); assert.equal(calls,1);
});
