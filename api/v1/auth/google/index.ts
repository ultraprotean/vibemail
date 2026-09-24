import { route } from '../../../../src/http/app';
import { authStartHandler } from '../../../../src/http/handlers';

/** GET /api/v1/auth/google — start Google sign-in (CONTRACT.md §6.1). */
export const GET = route(authStartHandler);
