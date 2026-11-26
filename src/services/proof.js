import { Buffer } from 'node:buffer';
import { EvriError } from './errors.js';

const MIME_TYPES = { PNG: 'image/png', JPEG: 'image/jpeg', GIF: 'image/gif', WEBP: 'image/webp' };
const WRAPPERS = ['data', 'result', 'results', 'photo', 'photos', 'safePlacePhoto',
  'safePlacePhotos', 'signature', 'signatures', 'body', 'response', 'items', 'images'];

export function detectImageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'PNG';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'JPEG';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'WEBP';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'GIF';
  return null;
}

export function normalizeImageFormat(value) {
  if (typeof value !== 'string') return null;
  const format = value.trim().toUpperCase().replace(/^IMAGE\//, '');
  return format === 'JPG' ? 'JPEG' : Object.hasOwn(MIME_TYPES, format) ? format : null;
}

// Canonical field from Evri Client Tracking API v1.2, pages 12-13.
// Only documented image field is accepted; optional wrappers are tolerated.
export function collectProofObjects(value, depth = 0, output = []) {
  if (depth > 8 || value === null || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) collectProofObjects(item, depth + 1, output);
    return output;
  }
  if (Object.hasOwn(value, 'base64EncodedBytes')) output.push(value);
  for (const key of WRAPPERS) {
    if (Object.hasOwn(value, key)) collectProofObjects(value[key], depth + 1, output);
  }
  return output;
}

function decodeBase64(value) {
  if (typeof value !== 'string') return null;
  const encoded = value.replace(/\s/g, '');
  // Standard base64 with optional omitted padding. Reject junk rather than
  // rely on Buffer's permissive base64 decoder.
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null;
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return null;
  if (encoded.includes('=') && encoded.length % 4 !== 0) return null;
  return buffer;
}

function proofFromBytes(bytes, { declaredFormat, printedName } = {}) {
  const detected = detectImageFormat(bytes);
  if (!detected) return null;
  const declared = normalizeImageFormat(declaredFormat);
  // Byte signature is authoritative for MIME; never send a JPEG as PNG.
  return { data: bytes.toString('base64'), mimeType: MIME_TYPES[detected], imageFormat: detected,
    ...(declared && declared !== detected ? { declaredImageFormat: declared } : {}),
    ...(typeof printedName === 'string' && printedName.trim() ? { printedName: printedName.trim() } : {}) };
}

export function parseProofResponse(bytes, resource) {
  if (!bytes.length) throw new EvriError('PROOF_UNAVAILABLE', 'Evri returned an empty proof response', { stage: resource });
  // The reference specifies JSON. Binary is a defensive fallback if a proxy
  // or future API returns a recognized image directly.
  const binary = proofFromBytes(bytes);
  if (binary) return [binary];
  let json;
  try { json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new EvriError('PROOF_INVALID_RESPONSE', 'Evri proof response is neither JSON nor a supported image', { stage: resource }); }
  const candidates = collectProofObjects(json);
  const images = [];
  const seen = new Set();
  let hadImageField = false;
  for (const item of candidates) {
    if (typeof item.base64EncodedBytes === 'string' && item.base64EncodedBytes.trim()) hadImageField = true;
    const decoded = decodeBase64(item.base64EncodedBytes);
    if (!decoded) continue;
    const proof = proofFromBytes(decoded, { declaredFormat: item.imageFormat, printedName: item.printedName });
    if (!proof || seen.has(proof.data)) continue;
    seen.add(proof.data);
    images.push(proof);
  }
  if (!images.length) {
    throw new EvriError(hadImageField ? 'PROOF_INVALID_IMAGE' : 'PROOF_UNAVAILABLE',
      hadImageField ? 'Evri returned base64EncodedBytes but no supported valid image data' :
        'Evri response did not contain populated base64EncodedBytes', { stage: resource });
  }
  return images;
}
