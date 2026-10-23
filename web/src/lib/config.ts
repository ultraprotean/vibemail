export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export const PAGE_SIZE = 20;
/** Page size used when paging through older mail to find a thread or search (§6.3 max). */
export const WIDE_PAGE_SIZE = 100;
export const MAX_WIDE_PAGES = 5;
export const REFRESH_INTERVAL_MS = 60_000;
