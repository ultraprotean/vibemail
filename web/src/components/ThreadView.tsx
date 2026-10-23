'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { displaySubject, formatFull, formatReceived, parseSender, senderInitials } from '@/lib/addresses';
import { gmailThreadUrl, messagesInThread } from '@/lib/threads';
import type { Message } from '@/lib/types';
import { useMailbox, type ThreadLookup } from './MailboxProvider';
import { useSettings } from './SettingsProvider';

type BodyMode = 'plain' | 'html';

interface HtmlOptions {
  /** Let the message fetch images from the sender's servers (https only). */
  remoteImages: boolean;
}

/**
 * HTML mail runs in a script-less sandbox. Scripts, remote stylesheets, fonts and every other
 * kind of remote content are always blocked; remote images load only when allowed. The page
 * address is never sent along with those image requests (no-referrer).
 */
export function buildHtmlDocument(html: string, options: HtmlOptions = { remoteImages: true }): string {
  const images = options.remoteImages ? 'data: https:' : 'data:';
  const csp = `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>body{margin:0;padding:4px;font:15px/1.5 system-ui,sans-serif;color:#222;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

function HtmlFrame({ html, title, remoteImages }: { html: string; title: string; remoteImages: boolean }) {
  const [height, setHeight] = useState(240);
  return (
    <iframe
      className="html-frame"
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={buildHtmlDocument(html, { remoteImages })}
      style={{ height }}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument;
        if (doc) setHeight(Math.min(Math.max(doc.documentElement.scrollHeight + 8, 120), 1600));
      }}
    />
  );
}

/**
 * HTML is the default view whenever a message has it; Plain is the default only when there is
 * no HTML. The toggle lets the reader switch, and resets when they open another thread.
 */
export function MessageBody({ message }: { message: Message }) {
  const { settings } = useSettings();
  const hasText = message.bodyText !== null && message.bodyText !== '';
  const hasHtml = message.bodyHtml !== null && message.bodyHtml !== '';
  const [mode, setMode] = useState<BodyMode>(hasHtml ? 'html' : 'plain');
  const [imagesLoadedHere, setImagesLoadedHere] = useState(false);

  if (!hasText && !hasHtml) {
    return <p className="body-text body-empty">{message.snippet || '(This message has no body.)'}</p>;
  }
  const showHtml = hasHtml && (mode === 'html' || !hasText);
  const remoteImages = settings.remoteImages || imagesLoadedHere;
  const hasRemoteImages = hasHtml && /<img\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(message.bodyHtml ?? '');
  return (
    <div className="body">
      <div className="body-toggle" role="group" aria-label="Message format">
        <button type="button" aria-pressed={!showHtml} disabled={!hasText} onClick={() => setMode('plain')}>
          Plain
        </button>
        <button type="button" aria-pressed={showHtml} disabled={!hasHtml} onClick={() => setMode('html')}>
          HTML
        </button>
      </div>
      {showHtml && message.bodyHtml ? (
        <>
          <HtmlFrame html={message.bodyHtml} title={`Message from ${parseSender(message.from).name}`} remoteImages={remoteImages} />
          {!remoteImages && hasRemoteImages && (
            <p className="body-note">
              Remote images are blocked.{' '}
              <button type="button" className="link-button" onClick={() => setImagesLoadedHere(true)}>
                Load images for this message
              </button>
            </p>
          )}
        </>
      ) : (
        <p className="body-text">{message.bodyText}</p>
      )}
    </div>
  );
}

interface ThreadViewProps {
  threadId: string;
  onBack: () => void;
  onReply: (message: Message) => void;
}

export function ThreadView({ threadId, onBack, onReply }: ThreadViewProps) {
  const mb = useMailbox();
  const thread = useMemo(() => messagesInThread(mb.pool, threadId), [mb.pool, threadId]);
  const [lookup, setLookup] = useState<'searching' | ThreadLookup>(thread.length > 0 ? 'found' : 'searching');
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const markedFor = useRef<string | null>(null);
  const { findThread, markThreadRead } = mb;

  useEffect(() => {
    let cancelled = false;
    void findThread(threadId).then((result) => {
      if (!cancelled) setLookup(result);
    });
    return () => {
      cancelled = true;
    };
  }, [findThread, threadId, attempt]);

  useEffect(() => {
    if (lookup === 'found' && markedFor.current !== threadId) {
      markedFor.current = threadId;
      void markThreadRead(threadId);
    }
  }, [lookup, threadId, markThreadRead]);

  const latest = thread[thread.length - 1];
  const first = thread[0];
  const latestPending = latest ? mb.pending.has(latest.id) : false;

  if (!latest || !first) {
    return (
      <section className="thread" aria-label="Conversation">
        <header className="thread-header">
          <button type="button" className="button button-quiet" onClick={onBack}>
            ← Back
          </button>
        </header>
        {lookup === 'searching' ? (
          <div className="panel" aria-busy="true" role="status">
            <p className="panel-title">Finding your conversation…</p>
            <div className="skeleton-line w70" />
            <div className="skeleton-line w55" />
          </div>
        ) : lookup === 'failed' ? (
          <div className="panel panel-problem" role="alert">
            <p className="panel-title">Couldn&apos;t load your conversation</p>
            <button
              type="button"
              className="button"
              onClick={() => {
                setLookup('searching');
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="panel" role="status">
            <p className="panel-title">This conversation isn&apos;t in your loaded mail</p>
            <p className="panel-text">It may have been deleted, or it is older than what has been loaded.</p>
            <button type="button" className="button" onClick={onBack}>
              Back to inbox
            </button>
          </div>
        )}
      </section>
    );
  }

  const isOpen = (m: Message) => m.id === latest.id || expanded.has(m.id);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="thread" aria-label="Conversation">
      <header className="thread-header">
        <button type="button" className="button button-quiet" onClick={onBack}>
          ← Back
        </button>
        <div className="thread-title">
          <h1>{displaySubject(first.subject)}</h1>
          <p>
            {thread.length} message{thread.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="thread-actions">
          <button type="button" className="button" onClick={() => onReply(latest)}>
            Reply
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={latestPending}
            onClick={() => void mb.setRead(latest.id, !latest.isRead)}
          >
            {latest.isRead ? 'Mark unread' : 'Mark read'}
          </button>
          <a className="button button-quiet" href={gmailThreadUrl(threadId)} target="_blank" rel="noopener noreferrer">
            View in Gmail
          </a>
        </div>
      </header>

      <ol className="thread-messages">
        {thread.map((message) => {
          const open = isOpen(message);
          const sender = parseSender(message.from);
          return (
            <li key={message.id} className="thread-message" data-open={open} data-unread={!message.isRead}>
              {open ? (
                <article>
                  <header className="message-head">
                    <span className="row-avatar" aria-hidden="true">
                      {senderInitials(message.from)}
                    </span>
                    <div className="message-meta">
                      <p className="message-from">
                        {sender.name} <span className="message-address">{sender.address !== sender.name ? `<${sender.address}>` : ''}</span>
                      </p>
                      <p className="message-to">to {message.to || '(unknown)'}</p>
                      {message.cc !== null && <p className="message-to">cc {message.cc}</p>}
                      <time className="message-time" dateTime={message.receivedAt}>
                        {formatFull(message.receivedAt)}
                      </time>
                    </div>
                    {message.id !== latest.id && (
                      <button type="button" className="button button-quiet" aria-expanded="true" onClick={() => toggle(message.id)}>
                        Collapse
                      </button>
                    )}
                  </header>
                  <MessageBody message={message} />
                </article>
              ) : (
                <button type="button" className="collapsed" aria-expanded="false" onClick={() => toggle(message.id)}>
                  <span className="row-avatar" aria-hidden="true">
                    {senderInitials(message.from)}
                  </span>
                  <span className="collapsed-from">{sender.name}</span>
                  <span className="collapsed-snippet">{message.snippet}</span>
                  <time className="row-time" dateTime={message.receivedAt}>
                    {formatReceived(message.receivedAt)}
                  </time>
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
