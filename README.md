# TORRO Evri Client Tracking MCP v1.2.2

Render-ready Node.js MCP server with Clerk OAuth authentication, reconstructed from the known v1.2.1 requirements. Implements all four existing tools, Evri Client Tracking API v1.2 (2 September 2026), and opt-in photo/signature diagnostics.

## Changes in v1.2.2

- Uses the exact documented photo endpoint `GET /client-tracking/v1/safe-place-photos?barcode=...` and signature endpoint `GET /client-tracking/v1/signatures?barcode=...`.
- Parses the documented `base64EncodedBytes` and `imageFormat` properties. Handles an optional `printedName` and returns native MCP image content with the detected MIME type, rather than placing Base64 in textual JSON. Image identification checks signatures/magic bytes, not full decoding. Documented response objects are preferred; arrays/known wrappers and recognized raw binary images are accepted defensively. No external image URLs are followed.
- `EVRI_DEBUG_PROOF=true` logs proof endpoint HTTP status, content type, response size, JSON structure, recognized field names, image data length and detected image format. It logs no full body, image bytes, credentials, parcel ID, names or URLs. Debug applies to both proof endpoints, including upstream HTTP errors and retries. Disabled by default.
- Distinguishes upstream HTTP failures from missing or invalid proof data.
- Preserves four tool names, shared Evri token caching, one retry on upstream 401, optional ETA, Clerk-only authentication, and deployment environment variable names.
- The original v1.2.1 archive could not be opened; this is a reconstruction, not a source-level diff. The Clerk server follows the official current Express guide, so dependency and OAuth implementation details may differ from v1.2.1. It requires Clerk OAuth `profile` scope and a matching resource audience. No separate static bearer token, proof-enable flag, or in-app staff allowlist is included.

## Tools

| Tool | Input | Result |
|---|---|---|
| `get_evri_tracking` | `tracking_id`, optional `include_eta` (default false) | Latest event, full event history, GPS when supplied, advertised resource types, optional ETA |
| `get_evri_eta` | `tracking_id` | ETA data, if enabled by Evri |
| `get_evri_delivery_photo` | `tracking_id` | Native MCP image(s) and metadata |
| `get_evri_signature` | `tracking_id` | Native MCP image(s), optional printed name and metadata |

All four tools require a verified Clerk OAuth access token. The tool schemas may be discovered without an access token, using Clerk's default discovery behaviour; no tracking or proof data is public. `tracking_id` is validated as a 16-character alphanumeric barcode.

## Prerequisites

- Node.js 22.18.0 or newer (Render can set `NODE_VERSION=22.18.0`).
- Existing Evri Client Tracking API credentials and entitlement to the relevant client, GPS, ETA, photo and signature products as applicable.
- Existing Clerk instance with OAuth and the exact MCP resource URL configured. Clerk must be set up so only authorised TORRO personnel can sign in. This is an internal tool, not a public customer-facing application. Login alone does not establish customer entitlement to a parcel or its delivery evidence. Verify order/recipient association before sharing delivery evidence with a customer. Do not deploy with open public registration.

## Render deployment: existing service

1. Extract this ZIP. Replace the files in the existing SDK repository with the files in its top-level directory. Do not overwrite your existing private `.env` or commit secrets. Commit/push the source and deploy the existing Render web service; do not create a new service unless required. If the old project has obsolete source files, remove them once you have backed up the repo.
2. Set Build Command to `npm install` and Start Command to `npm start`. Health check path: `/health`. The web server binds to `0.0.0.0` and Render supplies `PORT` automatically.
3. Confirm the six required variables below. Leave any working Evri endpoint overrides unchanged. Add `EVRI_DEBUG_PROOF=true` temporarily for the troubleshooting run. No changes to the existing ChatGPT custom app URL should be needed if the resource URL and service remain unchanged.
4. Run `npm test` locally or in a build environment. After dependencies are installed, run `npm run smoke` to verify installed MCP imports, four registered tools, and the application-level anonymous-call guard; this is not a live OAuth test.
5. After deployment, open `/health`, protected resource metadata, and the authorization server metadata URL shown below. Reconnect the custom app if Clerk asks for new consent.
6. Ask ChatGPT to retrieve tracking events and the delivery photo for the test shipment. Inspect Render logs for `[EVRI_PROOF_DEBUG]`. After troubleshooting, set `EVRI_DEBUG_PROOF=false` and redeploy.

## Environment variables

| Variable | Required | Value |
|---|---|---|
| `EVRI_API_KEY` | Yes | Evri API key |
| `EVRI_CLIENT_ID` | Yes | Evri OAuth Auth ID |
| `EVRI_CLIENT_SECRET` | Yes | Evri OAuth Auth Secret |
| `CLERK_PUBLISHABLE_KEY` | Yes | Existing Clerk instance publishable key (production on Render) |
| `CLERK_SECRET_KEY` | Yes | Full matching Clerk instance secret key (production on Render) |
| `MCP_RESOURCE_URL` | Yes | `https://YOUR-SERVICE.onrender.com/mcp` (exact URL, no trailing slash) |
| `NODE_VERSION` | Render | `22.18.0` or later |
| `NODE_ENV` | Render | `production` |
| `EVRI_DEBUG_PROOF` | No | `true` temporarily; default off |
| `EVRI_OAUTH_URL` | No | Defaults to `https://oauth.prod.evricloud.co.uk`; preserve existing credential-pack override if applicable |
| `EVRI_API_BASE_URL` | No | Defaults to `https://api.evri.com`; preserve existing working override if applicable |
| `PORT` | No | Render-provided automatically; local default 3000 |

The optional `render.yaml` can be used for a fresh deployment. On an existing service, retain the existing service name and environment variables. There is no need to add `MCP_BEARER_TOKEN`, `EVRI_PROOF_ENABLED`, or an in-app staff allowlist.

## Clerk and MCP discovery

The application uses Clerk's official `mcpAuth`, `protectedResourceMetadataHandler`, `authorizationServerMetadataHandler`, and `streamableHttpHandler` Express helpers with the MCP TypeScript SDK 1.x. Clerk's current Express guide specifies `@clerk/express` >=2.1.70, `@clerk/mcp-tools` >=1.0.0, `@modelcontextprotocol/sdk` >=1.32.0 and Node >=22.18.0; package.json uses compatible ranges. Keep `package-lock.json` generated by your successful `npm install` in version control for reproducible later deployments.

- `GET /health` is public and does not call Evri or prove authentication works.
- `GET /.well-known/oauth-protected-resource/mcp` provides MCP protected resource metadata. A root protected-resource alias is also included.
- `GET /.well-known/oauth-authorization-server` provides Clerk discovery for older clients.
- `/mcp` supports stateless Streamable HTTP. All tool calls are authenticated by Clerk; tool callbacks also check verified Clerk auth info before calling Evri.
- Use the same full URL in Clerk, the custom app, `MCP_RESOURCE_URL`, and the token audience. Enable Clerk's Include Audience setting, and allow the `profile` scope. If an already-issued token lacks the scope or audience, reconnect and consent. Keep your existing CIMD/DCR and client-admission configuration; the server does not invent a registration endpoint. Use Clerk's configured supported client-onboarding mechanism.
- The production Clerk application must be restricted to appropriate internal users. No additional staff allowlist was added to this SDK, in line with the original requirements.

Official Clerk guide: https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server

## Proof response and logs

The reference (pp. 12-13) describes a JSON object with `base64EncodedBytes`, `imageFormat`, optional `printedName` and `links`. The normalized image is returned as an MCP `image` content block (`data` is standard Base64, `mimeType` is an image media type). If Evri's declared format and recognized image header disagree, the header determines the MIME type. The SDK does not fetch any advertised external URL. A resource link does not guarantee API entitlement or a nonempty image.

Example diagnostic log (illustrative only; not an actual shipment response):

```
[EVRI_PROOF_DEBUG] {"resource":"safe-place-photos","status":200,"ok":true,"contentType":"application/json","contentLength":123456,"bodyBytes":123456,"detectedImageFormat":null,"bodyKind":"json","json":{"type":"object","keys":["base64EncodedBytes","imageFormat"],"otherKeyCount":0,"base64EncodedBytes":{"type":"string","characters":123000,"detectedImageFormat":"JPEG"},"imageFormat":"JPEG"},"proofFieldCount":1}
```

The top-level `detectedImageFormat: null` is normal for a JSON envelope; look at the nested Base64 field for the decoded image format. Unknown field names are counted instead of logged; diagnostics never print image contents or response field values (except recognized image format labels).

| Result | What to check |
|---|---|
| HTTP 200 + populated `base64EncodedBytes` | Should return an image if the bytes identify a supported format |
| HTTP 200 + missing/empty Base64 field | `PROOF_UNAVAILABLE`; inspect sanitized structure/field count |
| HTTP 200 + populated but unrecognized data | `PROOF_INVALID_IMAGE`; check format with Evri |
| HTTP 200 + malformed JSON/nonimage | `PROOF_INVALID_RESPONSE`; inspect content type |
| HTTP 403 | `EVRI_HTTP_403`; check client tracking/proof entitlement with Evri |
| HTTP 404 | `EVRI_HTTP_404`; resource not found through API |
| HTTP 401 at stage `oauth` | Check Evri OAuth credentials/endpoint/audience; no tracking call made |
| HTTP 401 at resource stage | Upstream authorization failed after refreshing token once |
| HTTP 429 | Respect Evri fair usage limit; do not repeatedly retry |

Evri Client Tracking API v1.2 docs: pp. 5-7 (OAuth), 9-10 (events), 11 (ETA), 12 (signatures), 13 (safe place photos), 14 (HTTP status codes). Associated Swagger: https://app.swaggerhub.com/apis-docs/EVRI/evri-client_tracking_api . The API specifies a 720 requests/minute fair-use limit; control aggregate use (no distributed rate limiter is implemented).

## Local development

```
npm install
npm test
npm run check
npm run smoke
cp .env.example .env
# Set credentials and the exact development Clerk resource URL.
npm start
```

## Validation status

19 dependency-free Node tests passed on Node 22.16.0 with mocked Evri HTTP responses; all JavaScript files were syntax-checked. These cover the canonical proof fields, PNG and JPEG header recognition, nested responses, binary fallback, errors, OAuth token caching/retry, tracking/ETA, MCP image content structure and log redaction. No real parcel photo was retrieved during testing. npm registry access was unavailable in the build environment, so dependencies were not installed, no lockfile was generated, the installed-dependency smoke test was not executed, and real Clerk OAuth / Render / live Evri integration was not validated. Run `npm install`, `npm run smoke` and the deployment checks above on your own service. The ZIP contains source files only; no live credentials or private customer evidence.
