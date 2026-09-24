import { preflight, route } from '../../../src/http/app';
import { listMessagesHandler } from '../../../src/http/handlers';

/** GET /api/v1/messages — the user's messages, newest first (CONTRACT.md §6.3). JWT required. */
export const GET = route(listMessagesHandler);
export const OPTIONS = preflight(['GET']);
