'use client';

import { displaySubject, formatReceived, parseSender, senderInitials } from '@/lib/addresses';
import type { Message } from '@/lib/types';
import { Highlight } from './Highlight';

interface MessageRowProps {
  message: Message;
  onOpen: (message: Message) => void;
  onToggleRead: (message: Message) => void;
  /** A read-state request for this row is in flight. */
  pending?: boolean;
  /** Search text to highlight; empty when not searching. */
  query?: string;
  now?: Date;
}

/** Shared by the inbox list and search results. */
export function MessageRow({ message, onOpen, onToggleRead, pending = false, query = '', now }: MessageRowProps) {
  const sender = parseSender(message.from);
  const unread = !message.isRead;
  const name = sender.name || '(unknown sender)';
  return (
    <li className="row" data-unread={unread} data-pending={pending}>
      <button type="button" className="row-open" onClick={() => onOpen(message)}>
        <span className="row-avatar" aria-hidden="true">
          {senderInitials(message.from)}
        </span>
        <span className="row-main">
          <span className="row-top">
            <span className="row-from">
              <Highlight text={name} query={query} />
            </span>
            <time className="row-time" dateTime={message.receivedAt}>
              {formatReceived(message.receivedAt, now)}
            </time>
          </span>
          <span className="row-subject">
            <Highlight text={displaySubject(message.subject)} query={query} />
          </span>
          <span className="row-snippet">
            <Highlight text={message.snippet} query={query} />
          </span>
        </span>
        <span className="visually-hidden">{unread ? 'Unread. ' : ''}Open conversation</span>
      </button>
      <button
        type="button"
        className="row-toggle"
        onClick={() => onToggleRead(message)}
        disabled={pending}
        aria-label={unread ? 'Mark as read' : 'Mark as unread'}
        title={unread ? 'Unread. Mark as read' : 'Read. Mark as unread'}
      >
        <span className="dot" aria-hidden="true" />
      </button>
    </li>
  );
}
