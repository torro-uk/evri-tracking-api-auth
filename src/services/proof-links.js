import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { validateBarcode } from './evri-api.js';
const RESOURCES = new Set(['safe-place-photos', 'signatures']);
const AAD = Buffer.from('torro-evri-proof-link-v1');
const digest = image => createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex');

// Encrypted and authenticated bearer capability; no tracking ID or image bytes in URL.
// No disk, database, or in-memory image cache. The image is re-fetched on access.
export function createProofLinks({ origin, secret, ttlSeconds = 300 }, now = Date.now) {
  if (!secret) return null;
  const key = Buffer.from(secret, 'hex');
  if (!/^[a-fA-F0-9]{64}$/.test(secret) || key.length !== 32) throw new Error('EVRI_PROOF_LINK_SECRET must be 64 hex characters');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) throw new Error('EVRI_PROOF_LINK_TTL must be 30-300 seconds');
  function issue(result, image) {
    if (!RESOURCES.has(result.resource)) throw new Error('Invalid proof resource');
    const iat = Math.floor(now() / 1000), exp = iat + ttlSeconds;
    const payload = { barcode: validateBarcode(result.trackingId), resource: result.resource, hash: digest(image), iat, exp };
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    const token = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
    return { imageUrl: new URL(`/proof/${token}`, origin).href, expiresAt: new Date(exp * 1000).toISOString() };
  }
  function verify(token) {
    try {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,1024}$/.test(token)) return null;
      const bytes = Buffer.from(token, 'base64url');
      if (bytes.toString('base64url') !== token) return null;
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(AAD); cipher.setAuthTag(bytes.subarray(12, 28));
      const p = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
      const t = Math.floor(now() / 1000);
      if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.iat > t || p.exp <= t || p.exp - p.iat > 300 || p.exp <= p.iat || !RESOURCES.has(p.resource) || !/^[a-f0-9]{64}$/.test(p.hash) || validateBarcode(p.barcode) !== p.barcode) return null;
      return p;
    } catch { return null; }
  }
  return { issue, verify };
}

export async function resolveProofLink(links, evri, token) {
  const claim = links?.verify(token);
  if (!claim) return null;
  const result = await evri.getProof(claim.barcode, claim.resource);
  const image = result.images.find(item => digest(item) === claim.hash);
  if (!image || !links.verify(token)) return null;
  return { bytes: Buffer.from(image.data, 'base64'), mimeType: image.mimeType };
}

export function proofLinkHandler(links, evri) {
  return async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    // Treat HEAD as verification only; do not fetch evidence for probes.
    if (!links?.verify(req.params.token)) return res.status(404).end();
    if (req.method === 'HEAD') return res.status(200).end();
    try {
      const image = await resolveProofLink(links, evri, req.params.token);
      if (!image) return res.status(404).end();
      res.set({ 'Content-Type': image.mimeType, 'Content-Disposition': 'inline', 'Content-Length': String(image.bytes.length) });
      return res.status(200).end(image.bytes);
    } catch { return res.status(502).end(); }
  };
}
