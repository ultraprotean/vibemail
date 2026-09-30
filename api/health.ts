import { healthHandler } from '../src/http/handlers';

/**
 * GET /api/health — liveness check (CONTRACT.md §6.8). `/` is rewritten here in vercel.json.
 * Deliberately not wrapped in `route()`: it must answer even without configuration.
 */
export const GET = healthHandler();
