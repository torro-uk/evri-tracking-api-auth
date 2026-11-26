// Run after npm install. No Evri credentials or live requests are needed.
import assert from 'node:assert/strict';
import { mcpAuth, isClerkAuthInfo, protectedResourceMetadataHandler,
  authorizationServerMetadataHandler, streamableHttpHandler } from '@clerk/mcp-tools/express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTrackingTools } from '../src/tools/tracking.js';
for (const dependency of [mcpAuth, isClerkAuthInfo, protectedResourceMetadataHandler,
  authorizationServerMetadataHandler, streamableHttpHandler, StreamableHTTPServerTransport]) assert.equal(typeof dependency, 'function');
const server = new McpServer({ name: 'smoke-test', version: '1.2.3' });
let evriCalls = 0;
const fail = () => { evriCalls++; throw new Error('Unauthenticated request reached Evri'); };
registerTrackingTools(server, { getTracking: fail, getEta: fail, getProof: fail }, isClerkAuthInfo);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'smoke-test-client', version: '1.0.0' });
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['get_evri_delivery_photo', 'get_evri_eta', 'get_evri_signature', 'get_evri_tracking']);
  for (const name of names) {
    const result = await client.callTool({ name, arguments: { tracking_id: 'H04B9A0000663089' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /NOT_AUTHENTICATED/);
  }
  assert.equal(evriCalls, 0);
  console.info('Smoke test passed: four MCP tools registered; anonymous tool calls blocked.');
} finally {
  await client.close();
  await server.close();
}
