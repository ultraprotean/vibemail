/**
 * Local-only drafts. CONTRACT.md has no draft endpoints, so there is no `draftId`:
 * a draft lives in this browser's localStorage (docs/DESIGN_SPEC.md "Compose drawer").
 */

export interface Draft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  savedAt: string;
}

const PREFIX = 'vibemail.draft.';
export const NEW_DRAFT_KEY = 'new';

/** One draft for new messages, one per thread for replies. */
export function draftKey(threadId?: string): string {
  return threadId ? `reply:${threadId}` : NEW_DRAFT_KEY;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function isDraftEmpty(draft: Pick<Draft, 'to' | 'cc' | 'bcc' | 'subject' | 'bodyText'>, replySubjectText = ''): boolean {
  return (
    draft.to.length === 0 &&
    draft.cc.length === 0 &&
    draft.bcc.length === 0 &&
    (draft.subject.trim() === '' || draft.subject === replySubjectText) &&
    draft.bodyText.trim() === ''
  );
}

export function loadDraft(key: string, storage: Storage = window.localStorage): Draft | null {
  try {
    const raw = storage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const d = parsed as Record<string, unknown>;
    if (
      !isStringArray(d.to) ||
      !isStringArray(d.cc) ||
      !isStringArray(d.bcc) ||
      typeof d.subject !== 'string' ||
      typeof d.bodyText !== 'string'
    ) {
      return null;
    }
    return {
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      bodyText: d.bodyText,
      savedAt: typeof d.savedAt === 'string' ? d.savedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: Omit<Draft, 'savedAt'>, storage: Storage = window.localStorage): void {
  try {
    const value: Draft = { ...draft, savedAt: new Date().toISOString() };
    storage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage may be full or blocked; a draft is a convenience, never a requirement.
  }
}

export function clearDraft(key: string, storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(PREFIX + key);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
