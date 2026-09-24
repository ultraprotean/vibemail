import type { MessageListPosition } from '../db/message-store';
import { InvalidRequestError } from './responses';

/**
 * Opaque pagination cursor for `GET /messages` (CONTRACT.md §6.3): the last row's
 * `(receivedAt, id)`, base64url-encoded JSON. Clients must treat it as opaque.
 */

export function encodeCursor(position: MessageListPosition): string {
  return Buffer.from(JSON.stringify({ r: position.receivedAt.toISOString(), i: position.id }), 'utf8').toString(
    'base64url',
  );
}

/** @throws InvalidRequestError for anything that isn't a cursor this API issued. */
export function decodeCursor(cursor: string): MessageListPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidRequestError('cursor is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || !('r' in parsed) || !('i' in parsed)) {
    throw new InvalidRequestError('cursor is invalid');
  }
  const { r, i } = parsed;
  const receivedAt = typeof r === 'string' ? new Date(r) : null;
  if (!receivedAt || Number.isNaN(receivedAt.getTime()) || typeof i !== 'string' || !/^[A-Za-z0-9_-]+$/.test(i)) {
    throw new InvalidRequestError('cursor is invalid');
  }
  return { receivedAt, id: i };
}
