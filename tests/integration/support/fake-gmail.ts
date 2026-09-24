import type { gmail_v1 } from 'googleapis';
import type { GmailApis } from '../../../src/providers/gmail/mailbox';

/**
 * An in-memory Gmail mailbox behind the same narrow API interfaces the real readers use,
 * so everything from the provider layer up is the production code. Gmail is the only
 * thing faked in the integration suite.
 */

type Message = gmail_v1.Schema$Message;
type HistoryRecord = gmail_v1.Schema$History;
type Method = 'list' | 'get' | 'history' | 'profile' | 'send' | 'modify';

export const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** An error shaped like the ones googleapis (gaxios) throws. */
export function gmailError(status: number, oauthError?: string): Error {
  return Object.assign(new Error(oauthError ?? `HTTP ${status}`), {
    response: { status, data: oauthError ? { error: oauthError } : { error: { code: status } } },
  });
}

export interface MessageSpec {
  id: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  labels?: string[];
  receivedAt?: string;
  text?: string;
  html?: string;
  /** Use lower/upper-case header names to exercise case-insensitive lookup. */
  headerCase?: 'lower' | 'upper';
}

export function gmailMessage(spec: MessageSpec, historyId: string): Message {
  const name = (h: string) => (spec.headerCase === 'lower' ? h.toLowerCase() : spec.headerCase === 'upper' ? h.toUpperCase() : h);
  const headers = [
    { name: name('Subject'), value: spec.subject ?? `Subject ${spec.id}` },
    { name: name('From'), value: spec.from ?? 'Sender <sender@example.com>' },
    { name: name('To'), value: spec.to ?? 'me@example.com' },
    ...(spec.cc ? [{ name: name('Cc'), value: spec.cc }] : []),
  ];
  const parts: gmail_v1.Schema$MessagePart[] = [];
  if (spec.text !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64url(spec.text) } });
  if (spec.html !== undefined) parts.push({ mimeType: 'text/html', body: { data: b64url(spec.html) } });
  return {
    id: spec.id,
    threadId: `thread-${spec.id}`,
    historyId,
    internalDate: String(new Date(spec.receivedAt ?? '2026-09-01T00:00:00Z').getTime()),
    snippet: `Snippet ${spec.id}`,
    labelIds: spec.labels ?? ['INBOX'],
    payload: { mimeType: 'multipart/alternative', headers, parts },
  };
}

export class FakeGmail {
  readonly messages = new Map<string, Message>();
  private history: Array<{ id: number; record: HistoryRecord }> = [];
  private historyCounter = 1000;
  /** History at or before this id has "expired" (history.list → 404). */
  private expiredThrough = 0;
  private failures = new Map<Method, Error>();
  private historyGate: Promise<void> | null = null;
  private sentCounter = 0;
  readonly calls: { historyStart: string[]; sentRaw: string[] } = { historyStart: [], sentRaw: [] };

  get currentHistoryId(): string {
    return String(this.historyCounter);
  }

  private bump(record: HistoryRecord): void {
    this.historyCounter += 10;
    this.history.push({ id: this.historyCounter, record: { id: String(this.historyCounter), ...record } });
  }

  /** Seed a message without recording history (e.g. mail that predates the watch). */
  seed(spec: MessageSpec): Message {
    const message = gmailMessage(spec, this.currentHistoryId);
    this.messages.set(spec.id, message);
    return message;
  }

  /** A message arriving: stored and recorded as `messagesAdded`. */
  deliver(spec: MessageSpec): void {
    this.historyCounter += 1;
    const message = gmailMessage(spec, String(this.historyCounter));
    this.messages.set(spec.id, message);
    this.bump({ messagesAdded: [{ message: { id: spec.id, threadId: message.threadId } }] });
  }

  /** A label change made in Gmail itself, recorded in history. */
  relabel(id: string, add: string[], remove: string[]): void {
    const message = this.messages.get(id);
    if (!message) throw new Error(`no message ${id}`);
    message.labelIds = [...(message.labelIds ?? []).filter((l) => !remove.includes(l)), ...add];
    message.historyId = String(this.historyCounter + 10);
    this.bump({
      ...(add.length ? { labelsAdded: [{ message: { id }, labelIds: add }] } : {}),
      ...(remove.length ? { labelsRemoved: [{ message: { id }, labelIds: remove }] } : {}),
    });
  }

  remove(id: string): void {
    this.messages.delete(id);
    this.bump({ messagesDeleted: [{ message: { id } }] });
  }

  /** Make history up to now unavailable, as Gmail does after about a week. */
  expireHistory(): void {
    this.expiredThrough = this.historyCounter;
  }

  failNext(method: Method, error: Error): void {
    this.failures.set(method, error);
  }

  /** Hold `history.list` until the returned function is called. */
  holdHistory(): () => void {
    let release = () => undefined as void;
    this.historyGate = new Promise<void>((resolve) => {
      release = () => {
        this.historyGate = null;
        resolve();
      };
    });
    return release;
  }

  private maybeFail(method: Method): void {
    const error = this.failures.get(method);
    if (error) {
      this.failures.delete(method);
      throw error;
    }
  }

  apis(): GmailApis {
    return {
      messages: {
        list: async (params) => {
          this.maybeFail('list');
          const all = [...this.messages.values()]
            .filter((m) => !params.labelIds || params.labelIds.every((l) => m.labelIds?.includes(l)))
            .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
          const start = Number(params.pageToken ?? 0);
          const size = params.maxResults ?? 100;
          const page = all.slice(start, start + size);
          const next = start + page.length < all.length ? String(start + page.length) : undefined;
          return {
            data: { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: next },
          };
        },
        get: async (params) => {
          this.maybeFail('get');
          const message = params.id ? this.messages.get(params.id) : undefined;
          if (!message) throw gmailError(404);
          return { data: structuredClone(message) };
        },
      },
      history: {
        list: async (params) => {
          if (this.historyGate) await this.historyGate;
          this.maybeFail('history');
          const start = Number(params.startHistoryId);
          this.calls.historyStart.push(String(params.startHistoryId));
          if (start < this.expiredThrough) throw gmailError(404);
          return {
            data: {
              history: this.history.filter((h) => h.id > start).map((h) => h.record),
              historyId: this.currentHistoryId,
            },
          };
        },
        getProfile: async () => {
          this.maybeFail('profile');
          return { data: { emailAddress: 'me@example.com', historyId: this.currentHistoryId } };
        },
      },
      send: {
        send: async (params) => {
          this.maybeFail('send');
          const raw = params.requestBody?.raw ?? '';
          this.calls.sentRaw.push(raw);
          const text = Buffer.from(raw, 'base64url').toString('utf8');
          const header = (name: string) => new RegExp(`^${name}: (.*)$`, 'mi').exec(text)?.[1] ?? '';
          const id = `sent${++this.sentCounter}`;
          this.historyCounter += 1;
          const message = gmailMessage(
            { id, subject: header('Subject'), to: header('To'), from: 'Me <me@example.com>', labels: ['SENT'], text: 'sent body' },
            this.currentHistoryId,
          );
          message.threadId = params.requestBody?.threadId ?? `thread-${id}`;
          this.messages.set(id, message);
          return { data: { id, threadId: message.threadId, labelIds: ['SENT'] } };
        },
      },
      modify: {
        modify: async (params) => {
          this.maybeFail('modify');
          const message = params.id ? this.messages.get(params.id) : undefined;
          if (!message) throw gmailError(404);
          const add = params.requestBody?.addLabelIds ?? [];
          const remove = params.requestBody?.removeLabelIds ?? [];
          message.labelIds = [...(message.labelIds ?? []).filter((l) => !remove.includes(l)), ...add.filter((l) => !(message.labelIds ?? []).includes(l))];
          return { data: { id: message.id, threadId: message.threadId, labelIds: message.labelIds } };
        },
      },
    };
  }
}
