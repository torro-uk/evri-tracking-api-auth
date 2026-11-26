const REQUIRED = ['EVRI_API_KEY', 'EVRI_CLIENT_ID', 'EVRI_CLIENT_SECRET',
  'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'MCP_RESOURCE_URL'];

function httpsUrl(value, key) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${key} must be a valid HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url;
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  let resource;
  try { resource = new URL(env.MCP_RESOURCE_URL.trim()); }
  catch { throw new Error('MCP_RESOURCE_URL must be a full URL ending in /mcp'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(resource.hostname);
  if ((resource.protocol !== 'https:' && !(local && resource.protocol === 'http:' && env.NODE_ENV !== 'production')) ||
      resource.pathname !== '/mcp' || resource.search || resource.hash || resource.username || resource.password) {
    throw new Error('MCP_RESOURCE_URL must be the exact HTTPS /mcp endpoint (HTTP localhost is allowed in development)');
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const oauth = httpsUrl(env.EVRI_OAUTH_URL || 'https://oauth.prod.evricloud.co.uk', 'EVRI_OAUTH_URL');
  const api = httpsUrl(env.EVRI_API_BASE_URL || 'https://api.evri.com', 'EVRI_API_BASE_URL');
  if (api.pathname !== '/') throw new Error('EVRI_API_BASE_URL must contain the API origin only');
  return {
    port,
    resourceUrl: resource.href,
    evri: {
      apiKey: env.EVRI_API_KEY.trim(), clientId: env.EVRI_CLIENT_ID.trim(),
      clientSecret: env.EVRI_CLIENT_SECRET.trim(), oauthUrl: oauth.href,
      apiBaseUrl: api.origin
    }
  };
}
