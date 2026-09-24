import { preflight, route } from '../../../../src/http/app';
import { markReadHandler } from '../../../../src/http/handlers';

/** PATCH /api/v1/messages/:id/read — mark read or unread (CONTRACT.md §6.5). JWT required. */
export const PATCH = route(markReadHandler);
export const OPTIONS = preflight(['PATCH']);
