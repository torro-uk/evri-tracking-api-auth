import { Buffer } from 'node:buffer';
import { detectImageFormat, normalizeImageFormat, collectProofObjects } from './proof.js';

const isEnabled = () => /^(true|1)$/i.test(process.env.EVRI_DEBUG_PROOF ?? '');
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const SAFE_FIELDS = new Set(['base64EncodedBytes', 'imageFormat', 'printedName', 'links', 'rel', 'href', 'data', 'result', 'results', 'photo', 'photos', 'safePlacePhoto', 'safePlacePhotos', 'signature', 'signatures', 'body', 'response', 'items', 'images', 'error', 'errors', 'code', 'message', 'status', 'statusCode', 'image', 'imageData', 'base64', 'mimeType', 'url', 'imageUrl']);
const NESTED = ['data', 'result', 'results', 'photo', 'photos', 'safePlacePhoto', 'safePlacePhotos', 'signature', 'signatures', 'body', 'response', 'items', 'images', 'error', 'errors'];

function describe(value, depth = 0) {
  const type = kind(value);
  if (type === 'array') return { type, count: value.length,
    ...(depth < 4 && value.length ? { first: describe(value[0], depth + 1) } : {}) };
  if (type !== 'object') return { type, ...(type === 'string' ? { characters: value.length } : {}) };
  const keys = Object.keys(value);
  const result = { type, keys: keys.filter(key => SAFE_FIELDS.has(key)), otherKeyCount: keys.filter(key => !SAFE_FIELDS.has(key)).length };
  if (Object.hasOwn(value, 'base64EncodedBytes')) {
    const encoded = value.base64EncodedBytes;
    result.base64EncodedBytes = { type: kind(encoded) };
    if (typeof encoded === 'string') {
      result.base64EncodedBytes.characters = encoded.length;
      result.base64EncodedBytes.detectedImageFormat = detectImageFormat(Buffer.from(encoded.trimStart().slice(0, 32), 'base64'));
    }
  }
  if (Object.hasOwn(value, 'imageFormat')) result.imageFormat = normalizeImageFormat(value.imageFormat);
  if (depth < 4) {
    const nested = {};
    for (const key of NESTED) if (Object.hasOwn(value, key)) nested[key] = describe(value[key], depth + 1);
    if (Object.keys(nested).length) result.nested = nested;
  }
  return result;
}

// Called with the response and the body already read by the API service.
// Optional cloning keeps the helper usable directly after a fetch as well.
// NEVER logs image bytes, body values, printed names, tracking IDs, URLs,
// credentials, authorization headers or user IDs.
export async function debugEvriProofResponse(response, resource = 'safe-place-photos', bodyBytes, logger = console.info) {
  if (!isEnabled() || !['safe-place-photos', 'signatures'].includes(resource)) return;
  const record = { resource, status: response.status, ok: response.ok };
  try {
    const rawType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    record.contentType = rawType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(rawType) ? rawType : null;
    const rawLength = response.headers.get('content-length');
    record.contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    const bytes = bodyBytes ?? Buffer.from(await response.clone().arrayBuffer());
    record.bodyBytes = bytes.length;
    record.detectedImageFormat = detectImageFormat(bytes);
    if (!bytes.length) record.bodyKind = 'empty';
    else if (record.detectedImageFormat) record.bodyKind = 'binary-image';
    else if (record.contentType?.includes('json') || /^[\s\uFEFF]*[\[{]/.test(bytes.subarray(0, 256).toString('utf8'))) {
      try {
        const parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
        record.bodyKind = 'json';
        record.json = describe(parsed);
        record.proofFieldCount = collectProofObjects(parsed).length;
      } catch { record.bodyKind = 'invalid-json'; }
    } else record.bodyKind = 'other';
  } catch { record.diagnosticError = 'Unable to inspect response'; }
  try { logger('[EVRI_PROOF_DEBUG]', JSON.stringify(record)); } catch { /* diagnostics must not interrupt retrieval */ }
}
