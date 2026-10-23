import { describe, expect, it, vi } from 'vitest';
import { createApiClient, loginUrl, parseMessagePage } from '@/lib/api';
import { ApiError, NetworkError } from '@/lib/errors';

const message = {
  id: 'm1',
  threadId: 't1',
  subject: 'Hi',
  from: 'A <a@x.example>',
  to: 'me@x.example',
  cc: null,
  snippet: 's',
  bodyText: 'body',
  bodyHtml: null,
  isRead: false,
  receivedAt: '2026-01-01T00:00:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function client(fetchImpl: typeof fetch, token: string | null = 'jwt-123') {
  return createApiClient({ baseUrl: 'https://api.example', getToken: () => token, fetchImpl });
}

describe('createApiClient', () => {
  it('lists messages with cursor, limit and unreadOnly and sends the Bearer token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { messages: [message], nextCursor: 'next' }));
    const page = await client(fetchImpl).listMessages({ limit: 20, cursor: 'abc', unreadOnly: true });

    expect(page.nextCursor).toBe('next');
    expect(page.messages[0]?.id).toBe('m1');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example/api/v1/messages?limit=20&cursor=abc&unreadOnly=true');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123');
    expect(init?.method).toBe('GET');
  });

  it('omits query parameters that are not set', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { messages: [], nextCursor: null }));
    await client(fetchImpl).listMessages({});
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://api.example/api/v1/messages');
  });

  it('marks read with no body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { id: 'm1', isRead: true }));
    await client(fetchImpl).setReadState('m1', true);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example/api/v1/messages/m1/read');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBeUndefined();
  });

  it('marks unread with { isRead: false }', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { id: 'm1', isRead: false }));
    const result = await client(fetchImpl).setReadState('m 1', false);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example/api/v1/messages/m%201/read');
    expect(JSON.parse(String(init?.body))).toEqual({ isRead: false });
    expect(result.isRead).toBe(false);
  });

  it('posts send requests as JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(201, { id: 's1', threadId: 't9', status: 'sent' }));
    const result = await client(fetchImpl).sendMessage({ to: ['a@x.example'], subject: 'S', bodyText: 'B', threadId: 't9' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example/api/v1/messages/send');
    expect(JSON.parse(String(init?.body))).toEqual({ to: ['a@x.example'], subject: 'S', bodyText: 'B', threadId: 't9' });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(result).toEqual({ id: 's1', threadId: 't9', status: 'sent' });
  });

  it('turns an error envelope into an ApiError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { error: { code: 'AUTH_FAILED', message: 'expired', details: { recoverable: false } } }));
    const error = await client(fetchImpl)
      .listMessages({})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('AUTH_FAILED');
    expect((error as ApiError).recoverable).toBe(false);
    expect((error as ApiError).status).toBe(401);
  });

  it('reports a missing response as NetworkError, not an API code', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(client(fetchImpl).listMessages({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('rejects malformed success payloads', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { nope: true }));
    await expect(client(fetchImpl).listMessages({})).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('parseMessagePage', () => {
  it('defaults missing optional text fields', () => {
    const page = parseMessagePage({ messages: [{ id: 'a', threadId: 'b', isRead: true, receivedAt: '2026-01-01T00:00:00.000Z' }] });
    expect(page.messages[0]).toMatchObject({ subject: '', from: '', to: '', cc: null, bodyText: null, bodyHtml: null });
    expect(page.nextCursor).toBeNull();
  });
});

describe('loginUrl', () => {
  it('points at the OAuth start endpoint', () => {
    expect(loginUrl('https://api.example')).toBe('https://api.example/api/v1/auth/google');
  });
});
