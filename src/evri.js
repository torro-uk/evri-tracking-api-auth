const DEFAULT_BASE = 'https://api.evri.com';
const DEFAULT_OAUTH_URL = 'https://oauth.prod.evricloud.co.uk';
const BARCODE = /^[A-Z0-9]{16}$/;
const ALLOWED_IMAGE_FORMATS = new Map([['PNG', 'image/png'], ['JPG', 'image/jpeg'], ['JPEG', 'image/jpeg'], ['GIF', 'image/gif'], ['WEBP', 'image/webp']]);

export function normaliseBarcode(barcode) {
  const cleaned = String(barcode || '').replace(/[\s-]/g, '').toUpperCase();
  if (!BARCODE.test(cleaned)) { const error = new Error('Tracking ID must be a 16-character Evri alphanumeric barcode'); error.code = 'INVALID_BARCODE'; throw error; }
  return cleaned;
}

export function createEvriClient({ apiKey, clientId, clientSecret, baseUrl = DEFAULT_BASE, oauthUrl = DEFAULT_OAUTH_URL, timeoutMs = 12000, fetchImpl = fetch }) {
  if (!apiKey || !clientId || !clientSecret) throw new Error('EVRI_API_KEY, EVRI_CLIENT_ID and EVRI_CLIENT_SECRET are all required');
  let cachedToken = null;
  let expiresAt = 0;
  let pendingToken = null;

  const request = async (url, options = {}, stage = 'unknown') => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      const raw = await response.text();
      let body;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      if (!response.ok) {
        // Never leak raw upstream errors: they may contain customer or credential data.
        const safeCode = typeof body?.error === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(body.error) ? body.error : null;
        const err = new Error(`${stage === 'oauth' ? 'Evri OAuth token request' : `Evri ${stage} API request`} failed (HTTP ${response.status})${safeCode ? `: ${safeCode}` : ''}`);
        err.code = `EVRI_HTTP_${response.status}`;
        err.stage = stage;
        err.httpStatus = response.status;
        err.upstreamCode = safeCode;
        err.retryAfter = response.headers?.get?.('retry-after') || null;
        throw err;
      }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') { const e = new Error('Evri API request timed out'); e.code = 'TIMEOUT'; e.stage = stage; throw e; }
      throw error;
    } finally { clearTimeout(timeout); }
  };

  const issueToken = async () => {
    const response = await request(oauthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience: 'client-tracking-api' })
    }, 'oauth');
    if (!response || typeof response.access_token !== 'string' || !response.access_token) {
      const error = new Error('Evri OAuth response did not contain access_token'); error.code = 'INVALID_TOKEN_RESPONSE'; throw error;
    }
    cachedToken = response.access_token;
    const ttl = Math.max(1, Number(response.expires_in) || 3600);
    expiresAt = Date.now() + Math.max(0, ttl - Math.min(60, Math.floor(ttl / 10))) * 1000;
    return cachedToken;
  };

  const token = async () => {
    if (cachedToken && Date.now() < expiresAt) return cachedToken;
    if (!pendingToken) pendingToken = issueToken().finally(() => { pendingToken = null; });
    return pendingToken;
  };

  const get = async (path, parameters, stage = 'tracking') => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    let accessToken = await token();
    const doGet = (t) => request(url, { method: 'GET', headers: { Authorization: `Bearer ${t}`, apikey: apiKey, Accept: 'application/json' } }, stage);
    try { return await doGet(accessToken); }
    catch (error) {
      if (error.code !== 'EVRI_HTTP_401') throw error;
      cachedToken = null; expiresAt = 0;
      accessToken = await token();
      return doGet(accessToken);
    }
  };

  function decodeProof(payload, barcode, kind, maxBytes = 8 * 1024 * 1024) {
    if (!payload || typeof payload !== 'object' || typeof payload.base64EncodedBytes !== 'string') {
      const e = new Error(`Evri did not return ${kind} image data`); e.code = 'PROOF_UNAVAILABLE'; throw e;
    }
    const raw = payload.base64EncodedBytes;
    const base64 = raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      const e = new Error('Evri returned invalid image data'); e.code = 'INVALID_IMAGE_DATA'; throw e;
    }
    if (base64.length > Math.ceil(maxBytes / 3) * 4 + 4) {
      const e = new Error('Evri image exceeds configured size limit'); e.code = 'IMAGE_TOO_LARGE'; throw e;
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > maxBytes || bytes.length === 0) {
      const e = new Error('Evri image missing or exceeds configured size limit'); e.code = 'IMAGE_TOO_LARGE'; throw e;
    }
    const fmt = String(payload.imageFormat || '').toUpperCase();
    const mimeType = ALLOWED_IMAGE_FORMATS.get(fmt);
    if (!mimeType) { const e = new Error('Evri returned an unsupported image format'); e.code = 'UNSUPPORTED_IMAGE_FORMAT'; throw e; }
    // Verify signatures to avoid rendering a mislabeled arbitrary file.
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isGif = bytes.subarray(0, 3).toString('ascii') === 'GIF';
    const isWebp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!(mimeType === 'image/png' && isPng || mimeType === 'image/jpeg' && isJpeg || mimeType === 'image/gif' && isGif || mimeType === 'image/webp' && isWebp)) {
      const e = new Error('Evri image format does not match its content'); e.code = 'INVALID_IMAGE_DATA'; throw e;
    }
    return { barcode, kind, mimeType, base64: bytes.toString('base64'), ...(typeof payload.printedName === 'string' ? { printedName: payload.printedName } : {}) };
  }

  return {
    async tracking(trackingId, includeEta = false) {
      const barcode = normaliseBarcode(trackingId);
      const eventsRaw = await get('/client-tracking/v1/events', { barcode, descriptionType: 'CLIENT' });
      const eventsArray = Array.isArray(eventsRaw) ? eventsRaw : (Array.isArray(eventsRaw?.events) ? eventsRaw.events : []);
      const events = eventsArray.map((event) => ({
        dateTime: event.dateTime ?? null,
        description: event.trackingPoint?.description ?? null,
        trackingPointId: event.trackingPoint?.trackingPointId ?? null,
        location: event.location ?? null,
        availableResources: Array.isArray(event.links) ? event.links.map(link => link.rel).filter(Boolean) : []
      })).sort((a, b) => (Date.parse(b.dateTime || '') || 0) - (Date.parse(a.dateTime || '') || 0));
      const result = { carrier: 'Evri', trackingId: barcode, source: 'Evri Client Tracking API v1.2', checkedAt: new Date().toISOString(), latestEvent: events[0] ?? null, events, eventsAvailable: events.length > 0 };
      if (includeEta) {
        try { result.eta = await get('/client-tracking/v1/etas', { barcode }, 'eta'); }
        catch (error) { result.eta = null; result.etaError = { code: error.code || 'ETA_UNAVAILABLE', message: error.message }; }
      }
      return result;
    },
    async eta(trackingId) {
      const barcode = normaliseBarcode(trackingId);
      return { trackingId: barcode, eta: await get('/client-tracking/v1/etas', { barcode }, 'eta') };
    },
    async safePlacePhoto(trackingId) {
      const barcode = normaliseBarcode(trackingId);
      return decodeProof(await get('/client-tracking/v1/safe-place-photos', { barcode }, 'safe-place-photo'), barcode, 'safe-place-photo');
    },
    async signature(trackingId) {
      const barcode = normaliseBarcode(trackingId);
      return decodeProof(await get('/client-tracking/v1/signatures', { barcode }, 'signature'), barcode, 'signature');
    }
  };
}
