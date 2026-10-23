'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isValidAddress } from '@/lib/addresses';
import { ApiError, NetworkError, isAuthFailed } from '@/lib/errors';
import { clearDraft, saveDraft, type Draft } from '@/lib/drafts';
import type { Message, SendRequest } from '@/lib/types';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useVisualViewportVars } from '@/lib/viewport';
import { AddressField, splitAddresses } from './AddressField';
import { useAuth } from './AuthProvider';
import { useToast } from './ToastProvider';

export type ComposeMode = 'new' | 'reply' | 'draft-restored';

export type DraftFields = Pick<Draft, 'to' | 'cc' | 'bcc' | 'subject' | 'bodyText'>;

interface ComposeDrawerProps {
  mode: ComposeMode;
  /** The message being replied to (reply mode, and restored reply drafts). */
  replyTo?: Message;
  initial: DraftFields;
  draftKey: string;
  onClose: () => void;
  onSent: () => void;
  /** Throw the saved draft away and restart in the base mode. */
  onDiscard: () => void;
}

export const RATE_LIMIT_COOLDOWN_SECONDS = 30;
const AUTOSAVE_DELAY_MS = 1000;

interface FieldErrors {
  to?: string;
  subject?: string;
  body?: string;
}

const TITLES: Record<ComposeMode, string> = {
  new: 'New message',
  reply: 'Reply',
  'draft-restored': 'Draft restored',
};

function excerptOf(message: Message): string {
  const source = message.bodyText && message.bodyText.trim() ? message.bodyText : message.snippet;
  const clipped = source.trim().slice(0, 400);
  return clipped.length < source.trim().length ? `${clipped}…` : clipped;
}

export function ComposeDrawer({ mode, replyTo, initial, draftKey, onClose, onSent, onDiscard }: ComposeDrawerProps) {
  const { api, expire } = useAuth();
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const locked = Boolean(replyTo);
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [bcc, setBcc] = useState(initial.bcc);
  const [toText, setToText] = useState('');
  const [ccText, setCcText] = useState('');
  const [bccText, setBccText] = useState('');
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.bodyText);
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const baseline = useRef(initial);
  const baselineSubject = baseline.current.subject;

  useVisualViewportVars(true);

  const fields = useCallback(
    (): DraftFields => ({
      to: [...to, ...(locked ? [] : splitAddresses(toText))],
      cc: [...cc, ...splitAddresses(ccText)],
      bcc: [...bcc, ...splitAddresses(bccText)],
      subject,
      bodyText: body,
    }),
    [to, cc, bcc, toText, ccText, bccText, subject, body, locked],
  );

  const persist = useCallback(() => {
    const f = fields();
    const hasContent =
      f.bodyText.trim() !== '' ||
      f.cc.length > 0 ||
      f.bcc.length > 0 ||
      (!locked && f.to.length > 0) ||
      (locked ? f.subject !== baselineSubject : f.subject.trim() !== '');
    if (hasContent) saveDraft(draftKey, f);
    else clearDraft(draftKey);
  }, [fields, locked, baselineSubject, draftKey]);

  // Autosave about one second after the last change.
  useEffect(() => {
    if (sending) return;
    const timer = setTimeout(persist, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [persist, sending]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const close = useCallback(() => {
    if (sending) return; // spec: no dismissal while a send is in flight
    persist();
    onClose();
  }, [sending, persist, onClose]);

  const initialFocus = locked ? bodyRef : toRef;
  useFocusTrap(panelRef, true, close, initialFocus);

  function validate(f: DraftFields): FieldErrors {
    const next: FieldErrors = {};
    if (f.to.length === 0) next.to = 'Add at least one recipient.';
    else {
      const bad = [...f.to, ...f.cc, ...f.bcc].find((a) => !isValidAddress(a));
      if (bad) next.to = `"${bad}" doesn't look like an email address.`;
    }
    if (f.to.length > 0 && !next.to) {
      const bad = [...f.cc, ...f.bcc].find((a) => !isValidAddress(a));
      if (bad) next.to = `"${bad}" doesn't look like an email address.`;
    }
    if (!f.subject.trim()) next.subject = 'Give it a subject.';
    if (!f.bodyText.trim()) next.body = 'Write a message first.';
    return next;
  }

  async function submit() {
    if (sending || cooldown > 0) return;
    const f = fields();
    // Fold any half-typed addresses into their chips before validating.
    setTo(f.to);
    setCc(f.cc);
    setBcc(f.bcc);
    setToText('');
    setCcText('');
    setBccText('');
    setSubmitted(true);
    setFormError(null);
    const found = validate(f);
    setErrors(found);
    if (found.to) {
      toRef.current?.focus();
      return;
    }
    if (found.subject) {
      subjectRef.current?.focus();
      return;
    }
    if (found.body) {
      bodyRef.current?.focus();
      return;
    }

    const request: SendRequest = {
      to: f.to,
      subject: f.subject,
      bodyText: f.bodyText,
      ...(f.cc.length > 0 ? { cc: f.cc } : {}),
      ...(f.bcc.length > 0 ? { bcc: f.bcc } : {}),
      ...(replyTo ? { threadId: replyTo.threadId } : {}),
    };

    setSending(true);
    try {
      await api.sendMessage(request);
      clearDraft(draftKey);
      toast.show('Sent', 'success');
      onSent();
    } catch (error) {
      setSending(false);
      saveDraft(draftKey, f);
      if (isAuthFailed(error)) {
        expire(error.recoverable);
        return;
      }
      if (error instanceof ApiError && error.code === 'INVALID_REQUEST') setFormError(error.message);
      else if (error instanceof ApiError && error.code === 'PROVIDER_ERROR') setFormError("Gmail couldn't send that. Your draft is safe. Try again.");
      else if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
        setFormError('Gmail asked us to slow down.');
        setCooldown(RATE_LIMIT_COOLDOWN_SECONDS);
      } else if (error instanceof NetworkError) setFormError("Can't reach VibeMail. Your draft is safe.");
      else setFormError('Something went wrong on our side. Your draft is safe.');
    }
  }

  const quoted = useMemo(() => (replyTo ? excerptOf(replyTo) : ''), [replyTo]);
  const invalidShown = submitted;

  return (
    <div className="compose-layer">
      <div className="compose-scrim" onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        className="compose"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-title"
        data-mode={mode}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="compose-handle" aria-hidden="true" />
        <header className="compose-header">
          <h2 id="compose-title">{TITLES[mode]}</h2>
          {mode === 'draft-restored' && (
            <button type="button" className="chip chip-discard" onClick={onDiscard} disabled={sending}>
              Discard draft
            </button>
          )}
          <button type="button" className="icon-button" aria-label="Close and keep draft" onClick={close} disabled={sending}>
            ×
          </button>
        </header>

        <div className="compose-body">
          <fieldset className="compose-fields" disabled={sending}>
            <AddressField
              label="To"
              values={to}
              text={toText}
              onValuesChange={setTo}
              onTextChange={setToText}
              readOnly={locked}
              showInvalid={invalidShown}
              error={errors.to}
              inputRef={toRef}
            />
            <div className="compose-toggles">
              {!showCc && (
                <button type="button" className="link-button" onClick={() => setShowCc(true)}>
                  Add Cc
                </button>
              )}
              {!showBcc && (
                <button type="button" className="link-button" onClick={() => setShowBcc(true)}>
                  Add Bcc
                </button>
              )}
            </div>
            {showCc && <AddressField label="Cc" values={cc} text={ccText} onValuesChange={setCc} onTextChange={setCcText} showInvalid={invalidShown} />}
            {showBcc && <AddressField label="Bcc" values={bcc} text={bccText} onValuesChange={setBcc} onTextChange={setBccText} showInvalid={invalidShown} />}

            <div className="field" data-invalid={Boolean(errors.subject)}>
              <label htmlFor="compose-subject" className="field-label">
                Subject
              </label>
              <input
                id="compose-subject"
                ref={subjectRef}
                type="text"
                value={subject}
                aria-invalid={Boolean(errors.subject)}
                aria-describedby={errors.subject ? 'compose-subject-error' : undefined}
                onChange={(e) => setSubject(e.target.value)}
              />
              {errors.subject && (
                <p id="compose-subject-error" className="field-error">
                  {errors.subject}
                </p>
              )}
            </div>

            <div className="field field-grow" data-invalid={Boolean(errors.body)}>
              <label htmlFor="compose-body" className="field-label">
                Message
              </label>
              <textarea
                id="compose-body"
                ref={bodyRef}
                rows={6}
                value={body}
                aria-invalid={Boolean(errors.body)}
                aria-describedby={errors.body ? 'compose-body-error' : undefined}
                onChange={(e) => setBody(e.target.value)}
                onFocus={(e) => e.currentTarget.scrollIntoView({ block: 'nearest' })}
              />
              {errors.body && (
                <p id="compose-body-error" className="field-error">
                  {errors.body}
                </p>
              )}
            </div>
          </fieldset>

          {replyTo && quoted && (
            <blockquote className="quoted" aria-label="Message you are replying to">
              {quoted}
            </blockquote>
          )}
        </div>

        <footer className="compose-footer">
          {formError && (
            <p className="form-error" role="alert">
              {formError}
              {cooldown > 0 ? ` Try again in ${cooldown}s.` : ''}
            </p>
          )}
          <div className="compose-actions">
            <span className="compose-hint">Drafts stay on this device.</span>
            <button type="button" className="button button-primary" onClick={() => void submit()} disabled={sending || cooldown > 0}>
              {sending ? 'Sending…' : cooldown > 0 ? `Wait ${cooldown}s` : 'Send'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
