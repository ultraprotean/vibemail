import { route } from '../../src/http/app';
import { gmailWebhookHandler } from '../../src/http/handlers';

/**
 * POST /webhook/gmail — Gmail Pub/Sub push target (CONTRACT.md §6.6). Outside /api/v1:
 * Google calls it, not the client. Authenticated by the `token` query parameter.
 */
export const POST = route(gmailWebhookHandler);
