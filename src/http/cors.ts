/**
 * CORS for the client-facing JSON routes (CONTRACT.md §2). Only `FRONTEND_URL` may call
 * the API from a browser. No cookies cross origins: the session is a Bearer token.
 */

export function corsHeaders(frontendUrl: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': frontendUrl,
    Vary: 'Origin',
  };
}

/** Answer a browser preflight (`OPTIONS`) for the given methods. */
export function preflightResponse(frontendUrl: string, methods: string[]): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(frontendUrl),
      'Access-Control-Allow-Methods': [...methods, 'OPTIONS'].join(', '),
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    },
  });
}
