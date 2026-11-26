# TORRO Evri Direct Tracking MCP v1.2.1 — Clerk OAuth

Read-only Node.js MCP server for **Evri Client Tracking API v1.2**. Deploy to Render and connect through ChatGPT's **OAuth** custom MCP connection. This is an update of the existing v1.1.0 SDK; `src/evri.js` and its original Evri tests are unchanged.

## What's new

- **All four tools enabled**, with no `EVRI_PROOF_ENABLED` switch.
- **No `MCP_BEARER_TOKEN`**. ChatGPT signs in through **Clerk OAuth**, and Clerk validates OAuth access tokens presented by the MCP client. Tokens still travel as standard OAuth Bearer tokens internally — you do not manually configure or distribute a static Bearer secret.
- All `/mcp` operations require Clerk sign-in and the full MCP resource URL in the token `aud` claim.
- No staff allowlist. Any user who can successfully sign in to the configured Clerk application can access all four tools. Restrict account creation within Clerk.
- Existing Evri tracking history, ETA, safe-place photo, and signature functionality retained.

## Tools

| Tool | Outcome | Requirements |
| --- | --- | --- |
| `get_evri_tracking(tracking_id, include_eta?)` | Tracking events and optional ETA | Clerk login |
| `get_evri_eta(tracking_id)` | ETA information | Same + Evri ETA entitlement |
| `get_evri_delivery_photo(tracking_id)` | Safe-place photo as MCP image | Same + Evri photo entitlement |
| `get_evri_signature(tracking_id)` | Signature image plus optional printed name | Same + Evri signature entitlement |

All requests use Evri's client credentials + `apikey` stored server-side. These are independent of Clerk authentication.

## Step 1 — Create or select a Clerk application

1. In [Clerk Dashboard](https://dashboard.clerk.com/), create or select the TORRO authentication application. Use the **production Clerk instance** for the deployed Render service.
2. In **Agents → MCP servers**, select **Add MCP server**, and register the **exact deployed MCP URL**, for example `https://torro-evri.onrender.com/mcp`. This URL must match `MCP_RESOURCE_URL` byte-for-byte (no trailing slash).
3. Turn on **Include Audience** in the OAuth application settings if not already enabled. The MCP checks that tokens have this exact URL in the `aud` claim.
4. Enable **public OAuth clients / CIMD** where suitable for ChatGPT, or enable Dynamic Client Registration if your client requires it. Your Clerk instance must allow the registration method offered by ChatGPT. Configure default scope `profile` if ChatGPT doesn't request it.
5. Disable public sign-up and create the single Clerk login you intend to use. Anyone using that login will have access to all four MCP tools.
6. Copy your **Publishable Key** and **Secret Key** from the Clerk dashboard. Do not put your secret key in ChatGPT or source control.

Clerk documentation: https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server

## Step 2 — Configure Render environment variables

```env
EVRI_API_KEY=YOUR_EXISTING_EVRI_API_KEY
EVRI_CLIENT_ID=YOUR_EXISTING_EVRI_OAUTH_AUTH_ID
EVRI_CLIENT_SECRET=YOUR_EXISTING_EVRI_OAUTH_AUTH_SECRET

CLERK_PUBLISHABLE_KEY=pk_live_... 
CLERK_SECRET_KEY=sk_live_...
MCP_RESOURCE_URL=https://YOUR-RENDER-SERVICE.onrender.com/mcp

NODE_ENV=production
```

**Do not set** `MCP_BEARER_TOKEN` or `EVRI_PROOF_ENABLED`; neither is used in v1.2.1.

`EVRI_CLIENT_ID` means the Evri OAuth Auth ID, not the numeric Evri parcel Client ID. The Evri token request still uses `audience: client-tracking-api` and caches/refreshes the token.

## Step 3 — Deploy

- Node.js **22.18.0 or later** is required by Clerk's current MCP integration. Configure Render's Node version accordingly (for example using a `NODE_VERSION` Render environment variable if Render does not select a suitable version automatically).
- Build command: `npm install` (or `npm ci` once you've generated and committed a lockfile).
- Start command: `npm start`.
- Health URL: `https://YOUR-RENDER-SERVICE.onrender.com/health` (public; reveals no secrets).
- Protected MCP URL: `https://YOUR-RENDER-SERVICE.onrender.com/mcp`.
- Protected resource metadata (public): `https://YOUR-RENDER-SERVICE.onrender.com/.well-known/oauth-protected-resource/mcp`.
- Legacy OAuth server metadata (public): `https://YOUR-RENDER-SERVICE.onrender.com/.well-known/oauth-authorization-server`.

The server **refuses to start** if Clerk keys, Evri credentials, or `MCP_RESOURCE_URL` are missing.

## Step 4 — Connect in ChatGPT

1. Keep the old unauthenticated Evri connection for reference, but use a **separate Render test service** to avoid interruption while validating OAuth (recommended).
2. Add a **new custom MCP connection** in ChatGPT using the Clerk-enabled service's `/mcp` URL, choosing **OAuth** rather than **No Authentication**.
3. ChatGPT should follow the metadata endpoints to the Clerk OAuth login and consent screen. Sign in using the configured Clerk account.
4. Discover tools; all four should appear. Test `get_evri_tracking` first, followed by a known photo/signature shipment for which TORRO is authorised to see evidence.
5. Once verified, migrate the primary service and remove the older unauthenticated ChatGPT connection.

You cannot reuse the old unauthenticated connection's saved credentials to complete an OAuth flow. OAuth sign-in might need to be repeated if ChatGPT or Clerk revokes the session.

## Security / Evri entitlement warning

Clerk authenticates the signed-in account; this SDK does not restrict users by Clerk ID. A shared account means you cannot distinguish individual staff members or revoke access for one person without changing shared credentials. **Neither checks whether the recipient/customer owns a specific parcel.** The photo/signature tools are for **internal TORRO support only**. Staff must verify the Shopify order/recipient entitlement before sharing any proof-of-delivery evidence with a customer. Do not expose the MCP to customers without implementing order-specific checks. Evri's Client Tracking v1.2 specification forbids anonymous proof access and requires end-user entitlement verification.

For a stronger control, extend the SDK with an authenticated TORRO Dashboard/Shopify order-ownership lookup in the proof tools; this package does not implement one.

## Testing and troubleshooting

Run `npm test` (offline unit tests of Evri client) and `npm run check` for Node syntax. Live Clerk login, Render deployment and Evri photo/signature entitlement require real account credentials and are **not** exercised by these unit tests.

- **401 from `/mcp` before login:** expected; the response should advertise OAuth protected-resource metadata via `WWW-Authenticate`.
- **OAuth token rejected after login:** verify the Clerk instance's keys, exact `MCP_RESOURCE_URL`, `aud` claim, `profile` scope, and CIMD/DCR client setting.
- **Evri API 403 for photo/signature:** Evri may not have enabled the corresponding tracking product for your account.
- **Evri OAuth 401:** check `EVRI_CLIENT_ID`, `EVRI_CLIENT_SECRET` and production OAuth audience `client-tracking-api`.

## Official reference

- [Clerk MCP Express implementation](https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server)
- [Clerk's MCP tools v1.0 announcement](https://clerk.com/changelog/2026-11-20-mcp-tools-1-0)
- Evri Client Tracking API v1.2 (provided by TORRO)
