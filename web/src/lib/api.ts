import { ApiError, NetworkError, errorFromResponse } from './errors';
import type { ApiClient, ListParams, Message, MessagePage, ReadResponse, SendRequest, SendResponse } from './types';

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unexpected(what: string): ApiError {
  return new ApiError('INTERNAL_ERROR', `Unexpected response from the server (${what})`, 200);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseMessage(value: unknown): Message {
  if (!isRecord(value)) throw unexpected('message');
  const { id, threadId, subject, from, to, snippet, isRead, receivedAt } = value;
  if (
    typeof id !== 'string' ||
    typeof threadId !== 'string' ||
    typeof isRead !== 'boolean' ||
    typeof receivedAt !== 'string'
  ) {
    throw unexpected('message fields');
  }
  return {
    id,
    threadId,
    subject: typeof subject === 'string' ? subject : '',
    from: typeof from === 'string' ? from : '',
    to: typeof to === 'string' ? to : '',
    cc: nullableString(value.cc),
    snippet: typeof snippet === 'string' ? snippet : '',
    bodyText: nullableString(value.bodyText),
    bodyHtml: nullableString(value.bodyHtml),
    isRead,
    receivedAt,
  };
}

export function parseMessagePage(value: unknown): MessagePage {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw unexpected('message list');
  return { messages: value.messages.map(parseMessage), nextCursor: nullableString(value.nextCursor) };
}

function parseSendResponse(value: unknown): SendResponse {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.threadId !== 'string') {
    throw unexpected('send');
  }
  return { id: value.id, threadId: value.threadId, status: 'sent' };
}

function parseReadResponse(value: unknown): ReadResponse {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.isRead !== 'boolean') {
    throw unexpected('read state');
  }
  return { id: value.id, isRead: value.isRead };
}

export function loginUrl(baseUrl: string): string {
  return `${baseUrl}/api/v1/auth/google`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function request(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = options.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const hasBody = init.body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch(`${options.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: hasBody ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new NetworkError();
    }
    if (!response.ok) throw await errorFromResponse(response);
    try {
      return await response.json();
    } catch {
      throw unexpected('not JSON');
    }
  }

  return {
    async listMessages(params: ListParams): Promise<MessagePage> {
      const query = new URLSearchParams();
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.cursor) query.set('cursor', params.cursor);
      if (params.unreadOnly) query.set('unreadOnly', 'true');
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return parseMessagePage(await request(`/api/v1/messages${suffix}`, { method: 'GET' }));
    },

    async sendMessage(body: SendRequest): Promise<SendResponse> {
      return parseSendResponse(await request('/api/v1/messages/send', { method: 'POST', body }));
    },

    // §6.5: no body marks the message read; `{ "isRead": false }` marks it unread.
    async setReadState(id: string, isRead: boolean): Promise<ReadResponse> {
      const path = `/api/v1/messages/${encodeURIComponent(id)}/read`;
      const init = isRead ? { method: 'PATCH' } : { method: 'PATCH', body: { isRead: false } };
      return parseReadResponse(await request(path, init));
    },
  };
}
