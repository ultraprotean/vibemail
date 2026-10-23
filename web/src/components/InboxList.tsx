'use client';

import type { Message } from '@/lib/types';
import { useMailbox } from './MailboxProvider';
import { MessageRow } from './MessageRow';

function EmptyArt() {
  return (
    <svg className="empty-art" viewBox="0 0 64 48" width="96" height="72" aria-hidden="true" focusable="false">
      <rect x="6" y="10" width="52" height="32" rx="4" fill="var(--surface-2)" stroke="var(--border)" strokeWidth="3" />
      <path d="M8 13 L32 31 L56 13" fill="none" stroke="var(--border)" strokeWidth="3" strokeLinejoin="round" />
      <rect x="27" y="3" width="10" height="6" rx="1" fill="var(--highlight)" stroke="var(--border)" strokeWidth="2" />
    </svg>
  );
}

export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <ul className="rows" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="row skeleton">
          <div className="row-open">
            <span className="row-avatar" />
            <span className="row-main">
              <span className="skeleton-line w40" />
              <span className="skeleton-line w70" />
              <span className="skeleton-line w55" />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ProblemPanel({ kind, onRetry }: { kind: 'network' | 'server'; onRetry: () => void }) {
  return (
    <div className="panel panel-problem" role="alert">
      <p className="panel-title">{kind === 'network' ? "Can't reach VibeMail right now" : 'Something went wrong on our side'}</p>
      <p className="panel-text">{kind === 'network' ? 'Check your connection, then try again.' : 'Your mail is safe. Give it another go in a moment.'}</p>
      <button type="button" className="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

interface InboxListProps {
  onOpen: (message: Message) => void;
}

export function InboxList({ onOpen }: InboxListProps) {
  const mb = useMailbox();

  if (mb.phase === 'loading') {
    return (
      <div aria-busy="true" aria-live="polite">
        <span className="visually-hidden">Loading your mail</span>
        <SkeletonRows />
      </div>
    );
  }
  if (mb.phase === 'error' && mb.messages.length === 0) {
    return <ProblemPanel kind={mb.problem?.kind ?? 'server'} onRetry={mb.reload} />;
  }
  if (mb.messages.length === 0) {
    return (
      <div className="panel panel-empty">
        <EmptyArt />
        <p className="panel-title">{mb.unreadOnly ? 'No unread mail' : 'Your inbox is empty'}</p>
        <p className="panel-text">{mb.unreadOnly ? "You're all caught up." : 'Nothing to see here. Enjoy the quiet.'}</p>
      </div>
    );
  }

  return (
    <>
      <ul className="rows">
        {mb.messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            pending={mb.pending.has(message.id)}
            onOpen={onOpen}
            onToggleRead={(m) => void mb.setRead(m.id, !m.isRead)}
          />
        ))}
      </ul>
      {mb.hasMore &&
        (mb.loadingMore ? (
          <p className="load-status" role="status">
            Fetching more mail…
          </p>
        ) : (
          <div className="load-more">
            <button type="button" className="button button-quiet" onClick={mb.loadMore}>
              Load more
            </button>
          </div>
        ))}
    </>
  );
}
