import { Buffer } from 'node:buffer';
import { EvriError, safeError } from './errors.js';
import { parseProofResponse } from './proof.js';
import { debugEvriProofResponse } from './evri-proof-debug.js';

const SOURCE = 'Evri Client Tracking API v1.2';
const TIMEOUT = 20000;
const PROOF = new Set(['safe-place-photos', 'signatures']);
const RESOURCES = new Set(['events', 'etas', ...PROOF]);
const SAFE_UPSTREAM_CODES = new Set(['access_denied', 'invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'invalid_token', 'insufficient_scope']);

function parseJson(bytes, stage) {
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new EvriError('EVRI_INVALID_RESPONSE', 'Evri did not return valid JSON', { stage }); }
}
function httpError(status, stage, bytes) {
  let upstreamCode;
  if (stage === 'oauth') {
    try { const code = JSON.parse(bytes.toString('utf8')).error; if (SAFE_UPSTREAM_CODES.has(code)) upstreamCode = code; } catch {}
  }
  const explanation = ({ 400: 'Invalid request', 401: 'Authentication failed', 403: 'Access denied; check Evri API product entitlement',
    404: 'Requested resource not found', 429: 'Evri rate limit exceeded' })[status] ?? 'Evri API request failed';
  return new EvriError(`EVRI_HTTP_${status}`, explanation, { stage, status, upstreamCode });
}

export function validateBarcode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{16}$/.test(value.trim())) {
    throw new EvriError('INVALID_TRACKING_ID', 'tracking_id must be a 16-character Evri parcel barcode');
  }
  return value.trim().toUpperCase();
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const links = Array.isArray(event.links) ? event.links : event.links && typeof event.links === 'object' ? [event.links] : [];
  const availableResources = [...new Set(links.map(link => link?.rel).filter(rel => typeof rel === 'string'))];
  const location = event.location;
  return { dateTime: event.dateTime ?? null,
    description: event.trackingPoint?.description ?? event.description ?? null,
    trackingPointId: event.trackingPoint?.trackingPointId ?? event.trackingPointId ?? null,
    location: location && typeof location.latitude === 'number' && typeof location.longitude === 'number'
      ? { latitude: location.latitude, longitude: location.longitude } : null,
    availableResources };
}

function eventsArray(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.events)) return json.events;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.events)) return json.data.events;
  throw new EvriError('EVRI_INVALID_RESPONSE', 'Evri tracking response did not contain an events array', { stage: 'events' });
}
const eventTime = event => { const ms = Date.parse(event.dateTime); return Number.isFinite(ms) ? ms : -Infinity; };
const metadata = trackingId => ({ carrier: 'Evri', trackingId, source: SOURCE, checkedAt: new Date().toISOString() });

export class EvriClient {
  #token = null;
  #tokenPromise = null;
  constructor(config, { fetchImpl = globalThis.fetch, debug = debugEvriProofResponse, now = Date.now } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.debug = debug;
    this.now = now;
  }

  async #fetchBytes(url, init, stage) {
    try {
      // Do not send our credentials to an unexpected redirect target.
      const response = await this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (PROOF.has(stage)) await this.debug(response, stage, bytes);
      return { response, bytes };
    } catch (error) {
      if (error instanceof EvriError) throw error;
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new EvriError(timeout ? 'EVRI_TIMEOUT' : 'EVRI_NETWORK_ERROR', timeout ? 'Evri request timed out' : 'Unable to complete Evri request', { stage });
    }
  }

  async #issueToken() {
    const { response, bytes } = await this.#fetchBytes(this.config.oauthUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.config.clientId,
        client_secret: this.config.clientSecret, audience: 'client-tracking-api' })
    }, 'oauth');
    if (!response.ok) throw httpError(response.status, 'oauth', bytes);
    const json = parseJson(bytes, 'oauth');
    if (typeof json?.access_token !== 'string' || !json.access_token.trim()) {
      throw new EvriError('EVRI_INVALID_TOKEN', 'Evri OAuth response did not contain an access token', { stage: 'oauth' });
    }
    const lifetime = Number(json.expires_in);
    const ttl = Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 300;
    this.#token = { value: json.access_token, refreshAt: this.now() + Math.max(0, ttl - Math.min(60, ttl / 10)) * 1000 };
    return this.#token;
  }

  async #getToken() {
    if (this.#token && this.now() < this.#token.refreshAt) return this.#token;
    if (!this.#tokenPromise) {
      this.#tokenPromise = this.#issueToken().finally(() => { this.#tokenPromise = null; });
    }
    return this.#tokenPromise;
  }

  async request(resource, barcode) {
    if (!RESOURCES.has(resource)) throw new Error('Unknown Evri resource');
    const trackingId = validateBarcode(barcode);
    const url = new URL(`/client-tracking/v1/${resource}`, this.config.apiBaseUrl);
    url.searchParams.set('barcode', trackingId);
    if (resource === 'events') url.searchParams.set('descriptionType', 'CLIENT');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#getToken();
      const { response, bytes } = await this.#fetchBytes(url, { method: 'GET', headers: {
        Authorization: `Bearer ${token.value}`, apikey: this.config.apiKey, Accept: 'application/json'
      } }, resource);
      if (response.status === 401 && attempt === 0) {
        if (this.#token === token) this.#token = null;
        continue;
      }
      if (!response.ok) throw httpError(response.status, resource, bytes);
      return PROOF.has(resource) ? parseProofResponse(bytes, resource) : parseJson(bytes, resource);
    }
    throw new EvriError('EVRI_HTTP_401', 'Authentication failed', { stage: resource, status: 401 });
  }

  async getTracking(barcode, includeEta = false) {
    const trackingId = validateBarcode(barcode);
    const raw = await this.request('events', trackingId);
    const events = eventsArray(raw).map(normalizeEvent).filter(Boolean).sort((a, b) => eventTime(b) - eventTime(a));
    const result = { ...metadata(trackingId), latestEvent: events[0] ?? null, events, eventsAvailable: events.length > 0 };
    if (includeEta) {
      try { result.eta = await this.request('etas', trackingId); }
      catch (error) { result.eta_error = safeError(error); }
    }
    return result;
  }
  async getEta(barcode) {
    const trackingId = validateBarcode(barcode);
    return { ...metadata(trackingId), eta: await this.request('etas', trackingId) };
  }
  async getProof(barcode, resource) {
    const trackingId = validateBarcode(barcode);
    if (!PROOF.has(resource)) throw new Error('Unknown proof resource');
    return { ...metadata(trackingId), resource, images: await this.request(resource, trackingId) };
  }
}
