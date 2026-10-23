'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseSender, replySubject } from '@/lib/addresses';
import { NEW_DRAFT_KEY, clearDraft, draftKey, loadDraft } from '@/lib/drafts';
import type { Message } from '@/lib/types';
import { useAuth } from './AuthProvider';
import { ComposeDrawer, type ComposeMode, type DraftFields } from './ComposeDrawer';
import { InboxList } from './InboxList';
import { LabelChips } from './LabelChips';
import { useMailbox } from './MailboxProvider';
import { SearchBar } from './SearchBar';
import { SearchResults } from './SearchResults';
import { SettingsDialog } from './SettingsDialog';
import { ThreadView } from './ThreadView';

interface ComposeState {
  mode: ComposeMode;
  replyTo?: Message;
  initial: DraftFields;
  draftKey: string;
  nonce: number;
}

const EMPTY_FIELDS: DraftFields = { to: [], cc: [], bcc: [], subject: '', bodyText: '' };

function baseFields(replyTo?: Message): DraftFields {
  if (!replyTo) return EMPTY_FIELDS;
  const address = parseSender(replyTo.from).address;
  return { to: address ? [address] : [], cc: [], bcc: [], subject: replySubject(replyTo.subject), bodyText: '' };
}

/** Pick the starting state: a saved draft means draft-restored, otherwise the base mode. */
function openCompose(replyTo: Message | undefined, nonce: number): ComposeState {
  const key = replyTo ? draftKey(replyTo.threadId) : NEW_DRAFT_KEY;
  const saved = loadDraft(key);
  if (saved) {
    const { to, cc, bcc, subject, bodyText } = saved;
    return { mode: 'draft-restored', replyTo, initial: { to, cc, bcc, subject, bodyText }, draftKey: key, nonce };
  }
  return { mode: replyTo ? 'reply' : 'new', replyTo, initial: baseFields(replyTo), draftKey: key, nonce };
}

export function InboxShell() {
  const router = useRouter();
  const params = useSearchParams();
  const threadId = params.get('thread');
  const mb = useMailbox();
  const { mock } = useAuth();
  const [query, setQuery] = useState('');
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const savedScroll = useRef(0);
  const nonce = useRef(0);
  const wasInThread = useRef(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const searching = query.trim().length > 0;

  const openThread = useCallback(
    (message: Message) => {
      savedScroll.current = window.scrollY;
      router.push(`/inbox?thread=${encodeURIComponent(message.threadId)}`);
    },
    [router],
  );

  const closeThread = useCallback(() => router.push('/inbox'), [router]);

  // Restore the list's scroll position when returning from a thread.
  useEffect(() => {
    if (threadId) {
      wasInThread.current = true;
      window.scrollTo(0, 0);
    } else if (wasInThread.current) {
      wasInThread.current = false;
      requestAnimationFrame(() => window.scrollTo(0, savedScroll.current));
    }
  }, [threadId]);

  // Ctrl/Cmd+K focuses search; Escape clears it and returns focus to the list.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (threadId) closeThread();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === 'Escape' && searching && !compose && !settingsOpen) {
        setQuery('');
        mainRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searching, compose, settingsOpen, threadId, closeThread]);

  const startCompose = (replyTo?: Message) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nonce.current += 1;
    setCompose(openCompose(replyTo, nonce.current));
  };

  const closeCompose = () => {
    setCompose(null);
    requestAnimationFrame(() => {
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus();
      else fabRef.current?.focus();
    });
  };

  const discardDraft = () => {
    setCompose((current) => {
      if (!current) return current;
      clearDraft(current.draftKey);
      nonce.current += 1;
      return {
        mode: current.replyTo ? 'reply' : 'new',
        replyTo: current.replyTo,
        initial: baseFields(current.replyTo),
        draftKey: current.draftKey,
        nonce: nonce.current,
      };
    });
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/inbox" onClick={(e) => { e.preventDefault(); setQuery(''); closeThread(); }}>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">VibeMail</span>
          <span className="brand-sub">Cozy</span>
        </a>
        {mock && <span className="sample-badge">Sample</span>}
        <SearchBar ref={searchRef} value={query} onChange={setQuery} />
        <button type="button" className="icon-button topbar-settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <span className="gear" aria-hidden="true" />
        </button>
      </header>

      <main id="main" ref={mainRef} className="content" tabIndex={-1}>
        {threadId && (
          <div className="thread-slide">
            <ThreadView key={threadId} threadId={threadId} onBack={closeThread} onReply={(m) => startCompose(m)} />
          </div>
        )}
        <div hidden={Boolean(threadId)}>
          <LabelChips unreadOnly={mb.unreadOnly} onToggleUnread={mb.setUnreadOnly} />
          {searching ? <SearchResults query={query} onOpen={openThread} /> : <InboxList onOpen={openThread} />}
        </div>
      </main>

      {!compose && (
        <button ref={fabRef} type="button" className="fab" onClick={() => startCompose()}>
          <span className="fab-icon" aria-hidden="true" />
          <span className="fab-label">New message</span>
        </button>
      )}

      {compose && (
        <ComposeDrawer
          key={compose.nonce}
          mode={compose.mode}
          replyTo={compose.replyTo}
          initial={compose.initial}
          draftKey={compose.draftKey}
          onClose={closeCompose}
          onSent={() => {
            closeCompose();
            mb.afterSend();
          }}
          onDiscard={discardDraft}
        />
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
