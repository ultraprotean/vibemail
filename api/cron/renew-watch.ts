import { route } from '../../src/http/app';
import { renewWatchHandler } from '../../src/http/handlers';

/**
 * GET /api/cron/renew-watch — daily Gmail watch renewal (CONTRACT.md §6.7), run by Vercel
 * Cron (vercel.json `crons`). Authenticated by `Authorization: Bearer <CRON_SECRET>`.
 */
export const GET = route(renewWatchHandler);
