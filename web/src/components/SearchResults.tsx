'use client';

import { useEffect, useMemo, useState } from 'react';
import { MAX_WIDE_PAGES } from '@/lib/config';
import { matchesQuery, sortNewestFirst } from '@/lib/threads';
import type { Message } from '@/lib/types';
import { useMailbox } from './MailboxProvider';
import { MessageRow } from './MessageRow';

interface SearchResultsProps {
  query: string;
  onOpen: (message: Message) => void;
}

/** Client-side search over loaded mail: no search endpoint exists in CONTRACT.md. */
export function SearchResults({ query, onOpen }: SearchResultsProps) {
  const mb = useMailbox();
  const [debounced, setDebounced] = useState(query);
  const [olderFailed, setOlderFailed] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useMemo(() => sortNewestFirst(mb.pool.filter((m) => matchesQuery(m, debounced))), [mb.pool, debounced]);
  const canLoadOlder = !exhausted && mb.olderPagesLoaded < MAX_WIDE_PAGES;

  async function loadOlder() {
    setOlderFailed(false);
    const result = await mb.loadOlder();
    if (!result.ok) setOlderFailed(true);
    else if (!result.more) setExhausted(true);
  }

  return (
    <section aria-label="Search results">
      <div className="search-scope" role="status">
        {mb.widening ? (
          <span>Looking through older mail…</span>
        ) : olderFailed ? (
          <span>
            Couldn&apos;t load older mail.{' '}
            <button type="button" className="link-button" onClick={() => void loadOlder()}>
              Try again
            </button>
          </span>
        ) : (
          <span>
            Searching {mb.pool.length} message{mb.pool.length === 1 ? '' : 's'} loaded so far.{' '}
            {canLoadOlder ? (
              <button type="button" className="link-button" onClick={() => void loadOlder()}>
                Load older mail
              </button>
            ) : (
              'That is all the mail we can search here.'
            )}
          </span>
        )}
      </div>
      {results.length === 0 ? (
        <div className="panel panel-empty">
          <p className="panel-title">No messages match your search.</p>
          <p className="panel-text">
            Checked {mb.pool.length} message{mb.pool.length === 1 ? '' : 's'}.
          </p>
        </div>
      ) : (
        <ul className="rows">
          {results.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              query={debounced}
              pending={mb.pending.has(message.id)}
              onOpen={onOpen}
              onToggleRead={(m) => void mb.setRead(m.id, !m.isRead)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
