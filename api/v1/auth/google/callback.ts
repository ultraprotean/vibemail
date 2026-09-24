import { route } from '../../../../src/http/app';
import { authCallbackHandler } from '../../../../src/http/handlers';

/** GET /api/v1/auth/google/callback — Google's OAuth redirect target (CONTRACT.md §6.2). */
export const GET = route(authCallbackHandler);
