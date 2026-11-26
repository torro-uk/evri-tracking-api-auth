import express from 'express';
import cors from 'cors';
import { isClerkAuthInfo, mcpAuth, protectedResourceMetadataHandler,
  authorizationServerMetadataHandler, streamableHttpHandler } from '@clerk/mcp-tools/express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { EvriClient } from './services/evri-api.js';
import { createProofLinks, proofLinkHandler } from './services/proof-links.js';
import { registerTrackingTools } from './tools/tracking.js';

const config = loadConfig();
const evri = new EvriClient(config.evri); // Share upstream token cache across requests.
const links = createProofLinks(config.proofLinks);
const authOptions = { resourceUrl: config.resourceUrl, requiredScopes: ['profile'] };
const app = express();
app.disable('x-powered-by');
app.use(cors({ exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'] }));
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'torro-evri-client-tracking', version: '1.2.3' }));

function createServer() {
  const server = new McpServer({ name: 'torro-evri-client-tracking', version: '1.2.3' });
  registerTrackingTools(server, evri, isClerkAuthInfo, links);
  return server;
}

// Clerk verifies OAuth access tokens, audience and scopes. The public
// discovery routes expose metadata, not tracking data. No tool is public.
app.all('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadataHandler(authOptions));
app.all('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler(authOptions));
app.all('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler());
// Optional bearer links are issued only by authenticated tools; never share with customers.
if (links) { app.head('/proof/:token', proofLinkHandler(links, evri)); app.get('/proof/:token', proofLinkHandler(links, evri)); }
app.all('/mcp', mcpAuth(authOptions), streamableHttpHandler(createServer, StreamableHTTPServerTransport));
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'request_too_large' });
  console.error('[MCP_SERVER_ERROR] Request failed');
  return res.status(500).json({ error: 'server_error' });
});
const listener = app.listen(config.port, '0.0.0.0', () => console.info(`TORRO Evri Client Tracking MCP v1.2.3 listening on port ${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => listener.close(() => process.exit(0)));
