import type { Message } from './types';

const byReceivedAscending = (a: Message, b: Message): number =>
  a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id.localeCompare(b.id);

/** No thread endpoint exists (docs/DESIGN_SPEC.md): group loaded messages, oldest first. */
export function messagesInThread(messages: readonly Message[], threadId: string): Message[] {
  return messages.filter((m) => m.threadId === threadId).sort(byReceivedAscending);
}

/** Newest first, ties broken by id, matching the server's `receivedAt` descending order. */
export function sortNewestFirst(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => byReceivedAscending(b, a));
}

/** Merge pages into one deduplicated, newest-first list; later entries replace earlier ones. */
export function mergeMessages(existing: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return sortNewestFirst([...byId.values()]);
}

/**
 * Case-insensitive match over the fields the spec lists: subject, from, to, cc, snippet
 * and bodyText. An empty (or all-space) query matches nothing: search is not active.
 */
export function matchesQuery(message: Message, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  return [message.subject, message.from, message.to, message.cc ?? '', message.snippet, message.bodyText ?? ''].some(
    (field) => field.toLowerCase().includes(needle),
  );
}

export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}
