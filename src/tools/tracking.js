import { z } from 'zod';
import { safeError } from '../services/errors.js';
import { text, proofContent } from './content.js';

const trackingId = z.string().min(1).max(50).describe('Evri 16-character parcel barcode');
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export function registerTrackingTools(server, evri, isClerkAuthInfo) {
  const protect = action => async (args, context) => {
    if (!isClerkAuthInfo(context?.authInfo)) {
      return { isError: true, content: [text({ error: 'NOT_AUTHENTICATED', message: 'Clerk OAuth authentication is required.' })] };
    }
    try { return await action(args); }
    catch (error) { return { isError: true, content: [text(safeError(error))] }; }
  };
  server.registerTool('get_evri_tracking', {
    description: 'Fetch live Evri scan history and latest event. Optionally retrieve ETA. CLIENT descriptions are for internal use only.',
    inputSchema: { tracking_id: trackingId, include_eta: z.boolean().optional().default(false) }, annotations
  }, protect(async ({ tracking_id, include_eta }) => ({ content: [text(await evri.getTracking(tracking_id, include_eta))] })));
  server.registerTool('get_evri_eta', {
    description: 'Fetch Evri delivery or collection ETA, if enabled on TORRO account.', inputSchema: { tracking_id: trackingId }, annotations
  }, protect(async ({ tracking_id }) => ({ content: [text(await evri.getEta(tracking_id))] })));
  server.registerTool('get_evri_delivery_photo', {
    description: 'Retrieve Evri safe-place delivery photograph as an image. Sensitive delivery evidence for internal TORRO use only. Confirm recipient/order entitlement before disclosing to a customer. Clerk login is not itself proof of parcel entitlement.',
    inputSchema: { tracking_id: trackingId }, annotations
  }, protect(async ({ tracking_id }) => proofContent(await evri.getProof(tracking_id, 'safe-place-photos'))));
  server.registerTool('get_evri_signature', {
    description: 'Retrieve Evri delivery signature as an image with available printed name. Sensitive delivery evidence for internal TORRO use only. Confirm recipient/order entitlement before disclosing to a customer. Clerk login is not itself proof of parcel entitlement.',
    inputSchema: { tracking_id: trackingId }, annotations
  }, protect(async ({ tracking_id }) => proofContent(await evri.getProof(tracking_id, 'signatures'))));
}
