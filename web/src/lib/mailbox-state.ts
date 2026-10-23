import { sortNewestFirst } from './threads';
import type { Message, MessagePage } from './types';

/**
 * Pure state transitions for the mailbox. `byId` holds every message fetched by any
 * request (the pool used by thread view and search); `listIds` is the ordered inbox list
 * for the current filter, which follows the server's `receivedAt` descending order.
 */
export interface MailboxData {
  byId: Record<string, Message>;
  listIds: string[];
  listCursor: string | null;
  /** Cursor for unfiltered wide paging; undefined = not started, null = exhausted. */
  poolCursor: string | null | undefined;
}

export const EMPTY_MAILBOX: MailboxData = { byId: {}, listIds: [], listCursor: null, poolCursor: undefined };

function intoPool(
  byId: Record<string, Message>,
  messages: readonly Message[],
  protectedIds: ReadonlySet<string>,
): Record<string, Message> {
  const next = { ...byId };
  for (const m of messages) {
    if (protectedIds.has(m.id) && next[m.id]) continue; // keep an in-flight optimistic value
    next[m.id] = m;
  }
  return next;
}

function orderIds(byId: Record<string, Message>, ids: Iterable<string>): string[] {
  const messages: Message[] = [];
  for (const id of new Set(ids)) {
    const m = byId[id];
    if (m) messages.push(m);
  }
  return sortNewestFirst(messages).map((m) => m.id);
}

const none: ReadonlySet<string> = new Set();

/** Replace the list with a fresh first page (filter change, retry). */
export function applyFirstPage(data: MailboxData, page: MessagePage, protectedIds: ReadonlySet<string> = none): MailboxData {
  const byId = intoPool(data.byId, page.messages, protectedIds);
  return { ...data, byId, listIds: page.messages.map((m) => m.id), listCursor: page.nextCursor };
}

/**
 * Merge a refreshed first page into an already-loaded list without dropping deeper pages.
 * Falls back to replacing the list when the page does not overlap it (a gap) or already
 * contains the whole mailbox.
 */
export function applyRefreshedPage(data: MailboxData, page: MessagePage, protectedIds: ReadonlySet<string> = none): MailboxData {
  const pageIds = page.messages.map((m) => m.id);
  const pageIdSet = new Set(pageIds);
  const overlaps = data.listIds.some((id) => pageIdSet.has(id));
  if (data.listIds.length === 0 || !overlaps || page.nextCursor === null) {
    return applyFirstPage(data, page, protectedIds);
  }
  const byId = intoPool(data.byId, page.messages, protectedIds);
  const oldest = page.messages[page.messages.length - 1];
  const kept = data.listIds.filter((id) => {
    if (pageIdSet.has(id)) return true;
    const m = data.byId[id];
    if (!m || !oldest) return true;
    const newerThanPage = m.receivedAt > oldest.receivedAt || (m.receivedAt === oldest.receivedAt && m.id > oldest.id);
    return !newerThanPage; // newer than the page but absent from it: deleted upstream
  });
  return { ...data, byId, listIds: orderIds(byId, [...kept, ...pageIds]) };
}

export function applyMorePage(data: MailboxData, page: MessagePage, protectedIds: ReadonlySet<string> = none): MailboxData {
  const byId = intoPool(data.byId, page.messages, protectedIds);
  return {
    ...data,
    byId,
    listIds: orderIds(byId, [...data.listIds, ...page.messages.map((m) => m.id)]),
    listCursor: page.nextCursor,
  };
}

export function applyPoolPage(data: MailboxData, page: MessagePage, protectedIds: ReadonlySet<string> = none): MailboxData {
  return { ...data, byId: intoPool(data.byId, page.messages, protectedIds), poolCursor: page.nextCursor };
}

export function patchMessage(data: MailboxData, id: string, patch: Partial<Message>): MailboxData {
  const current = data.byId[id];
  if (!current) return data;
  return { ...data, byId: { ...data.byId, [id]: { ...current, ...patch } } };
}

export function removeMessage(data: MailboxData, id: string): MailboxData {
  if (!data.byId[id]) return data;
  const byId = { ...data.byId };
  delete byId[id];
  return { ...data, byId, listIds: data.listIds.filter((x) => x !== id) };
}

export function listMessages(data: MailboxData): Message[] {
  const out: Message[] = [];
  for (const id of data.listIds) {
    const m = data.byId[id];
    if (m) out.push(m);
  }
  return out;
}
