import express from 'express';
import cors from 'cors';
import {
  mcpAuth,
  protectedResourceMetadataHandler,
  authorizationServerMetadataHandler,
  streamableHttpHandler,
} from '@clerk/mcp-tools/express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createEvriClient } from './evri.js';

const version = '1.2.1';
const port = Number(process.env.PORT || 10000);
const required = [
  'EVRI_API_KEY', 'EVRI_CLIENT_ID', 'EVRI_CLIENT_SECRET',
  'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'MCP_RESOURCE_URL',
];
const missing = required.filter(key => !process.env[key]?.trim());
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);

const resourceUrl = new URL(process.env.MCP_RESOURCE_URL);
if (resourceUrl.pathname !== '/mcp' || resourceUrl.search || resourceUrl.hash ||
    (process.env.NODE_ENV === 'production' && resourceUrl.protocol !== 'https:')) {
  throw new Error('MCP_RESOURCE_URL must be the exact public /mcp endpoint; use HTTPS in production.');
}

const mcpAuthOptions = {
  resourceUrl: resourceUrl.toString(),
  requiredScopes: ['profile'],
  discoverable: false,
};

const evri = createEvriClient({
  apiKey: process.env.EVRI_API_KEY,
  clientId: process.env.EVRI_CLIENT_ID,
  clientSecret: process.env.EVRI_CLIENT_SECRET,
  baseUrl: process.env.EVRI_BASE_URL || 'https://api.evri.com',
  oauthUrl: process.env.EVRI_OAUTH_URL || 'https://oauth.prod.evricloud.co.uk',
  timeoutMs: Number(process.env.EVRI_TIMEOUT_MS || 12000),
});

function errorResult(error) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({
    error: error.code || 'EVRI_LOOKUP_FAILED', message: error.message,
    ...(error.stage ? { stage: error.stage } : {}),
    ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
  }) }] };
}
const barcodeSchema = z.string().min(1).max(50).describe('Evri 16-character parcel barcode');

// All four tools are protected by Clerk OAuth middleware on /mcp.
// OAuth proves identity but does not prove entitlement to any particular parcel.
function guarded(handler) {
  return async (args) => {
    try { return await handler(args); }
    catch (error) { return errorResult(error); }
  };
}
const asText = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
function imageResult(image, proofType) {
  return { content: [
    { type: 'text', text: JSON.stringify({ trackingId: image.barcode, proofType, ...(image.printedName ? { printedName: image.printedName } : {}) }) },
    { type: 'image', data: image.base64, mimeType: image.mimeType },
  ] };
}

export function createServer() {
  const server = new McpServer({ name: 'torro-evri-direct-tracking', version });
  server.registerTool('get_evri_tracking', {
    description: 'Fetch live Evri scan history and latest event. Optionally retrieve ETA. CLIENT descriptions are for internal use only.',
    inputSchema: { tracking_id: barcodeSchema, include_eta: z.boolean().optional().default(false) },
  }, guarded(async ({ tracking_id, include_eta }) => asText(await evri.tracking(tracking_id, include_eta))));

  server.registerTool('get_evri_eta', {
    description: 'Fetch Evri delivery or collection ETA, if enabled on TORRO account.',
    inputSchema: { tracking_id: barcodeSchema },
  }, guarded(async ({ tracking_id }) => asText(await evri.eta(tracking_id))));

  const proofDescription = 'Sensitive delivery evidence for internal TORRO use only. Confirm recipient/order entitlement before disclosing to a customer. Clerk login is not itself proof of parcel entitlement.';
  server.registerTool('get_evri_delivery_photo', {
    description: `Retrieve Evri safe-place delivery photograph as an image. ${proofDescription}`,
    inputSchema: { tracking_id: barcodeSchema },
  }, guarded(async ({ tracking_id }) => imageResult(await evri.safePlacePhoto(tracking_id), 'safe-place-photo')));

  server.registerTool('get_evri_signature', {
    description: `Retrieve Evri delivery signature as an image with available printed name. ${proofDescription}`,
    inputSchema: { tracking_id: barcodeSchema },
  }, guarded(async ({ tracking_id }) => imageResult(await evri.signature(tracking_id), 'signature')));
  return server;
}

const app = express();
app.disable('x-powered-by');
app.use(cors({ exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'] }));
app.use(express.json({ limit: '64kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', version, service: 'torro-evri-direct-tracking-mcp', auth: 'clerk-oauth', tools: 4 }));

// Clerk checks OAuth signature, expiry, resource audience and profile scope.
// The transport creates a fresh stateless MCP instance per incoming POST.
app.all('/mcp', mcpAuth(mcpAuthOptions), streamableHttpHandler(createServer, StreamableHTTPServerTransport));
// OAuth discovery MUST remain publicly accessible, even while /mcp is protected.
app.all('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadataHandler(mcpAuthOptions));
app.all('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());

app.listen(port, '0.0.0.0', () => console.log(`Evri Direct Tracking MCP ${version} (Clerk OAuth) on port ${port}`));
