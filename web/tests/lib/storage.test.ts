import { describe, expect, it } from 'vitest';
import { NEW_DRAFT_KEY, clearDraft, draftKey, isDraftEmpty, loadDraft, saveDraft } from '@/lib/drafts';
import { clearMode, clearToken, readMode, readToken, setNotice, takeNotice, tokenFromHash, writeMode, writeToken } from '@/lib/token';
import { DRAWER_MAX_VIEWPORT_SHARE, drawerMaxHeight } from '@/lib/viewport';

describe('drafts', () => {
  const fields = { to: ['a@x.example'], cc: [], bcc: [], subject: 'Hi', bodyText: 'Body' };

  it('keys new messages and replies separately', () => {
    expect(draftKey()).toBe(NEW_DRAFT_KEY);
    expect(draftKey('t1')).toBe('reply:t1');
    expect(draftKey('t1')).not.toBe(draftKey('t2'));
  });

  it('round-trips a draft and clears it', () => {
    expect(loadDraft(NEW_DRAFT_KEY)).toBeNull();
    saveDraft(NEW_DRAFT_KEY, fields);
    expect(loadDraft(NEW_DRAFT_KEY)).toMatchObject(fields);
    clearDraft(NEW_DRAFT_KEY);
    expect(loadDraft(NEW_DRAFT_KEY)).toBeNull();
  });

  it('keeps reply drafts per thread', () => {
    saveDraft('reply:t1', { ...fields, bodyText: 'one' });
    saveDraft('reply:t2', { ...fields, bodyText: 'two' });
    expect(loadDraft('reply:t1')?.bodyText).toBe('one');
    expect(loadDraft('reply:t2')?.bodyText).toBe('two');
  });

  it('ignores corrupt stored drafts', () => {
    window.localStorage.setItem('vibemail.draft.new', '{"to":"nope"}');
    expect(loadDraft(NEW_DRAFT_KEY)).toBeNull();
    window.localStorage.setItem('vibemail.draft.new', 'not json');
    expect(loadDraft(NEW_DRAFT_KEY)).toBeNull();
  });

  it('knows when a draft is empty', () => {
    expect(isDraftEmpty({ to: [], cc: [], bcc: [], subject: '', bodyText: '' })).toBe(true);
    expect(isDraftEmpty({ to: [], cc: [], bcc: [], subject: 'Re: x', bodyText: '' }, 'Re: x')).toBe(true);
    expect(isDraftEmpty(fields)).toBe(false);
  });
});

describe('token', () => {
  it('reads the token from a #token= fragment', () => {
    expect(tokenFromHash('#token=abc.def.ghi')).toBe('abc.def.ghi');
    expect(tokenFromHash('token=abc')).toBe('abc');
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#other=1')).toBeNull();
    expect(tokenFromHash('#token=')).toBeNull();
  });

  it('stores and clears the token', () => {
    expect(readToken()).toBeNull();
    writeToken('jwt');
    expect(readToken()).toBe('jwt');
    clearToken();
    expect(readToken()).toBeNull();
  });

  it('shows a sign-in notice once', () => {
    setNotice('Your session ended.');
    expect(takeNotice()).toBe('Your session ended.');
    expect(takeNotice()).toBeNull();
  });
});

describe('launch mode', () => {
  it('remembers gmail or sample and ignores anything else', () => {
    expect(readMode()).toBeNull();
    writeMode('sample');
    expect(readMode()).toBe('sample');
    writeMode('gmail');
    expect(readMode()).toBe('gmail');
    window.localStorage.setItem('vibemail.mode', 'bogus');
    expect(readMode()).toBeNull();
    writeMode('sample');
    clearMode();
    expect(readMode()).toBeNull();
  });
});

describe('compose drawer viewport cap', () => {
  it('is 58% of the visual viewport height', () => {
    expect(DRAWER_MAX_VIEWPORT_SHARE).toBe(0.58);
    expect(drawerMaxHeight(844)).toBe(489);
    expect(drawerMaxHeight(400)).toBe(232);
  });
});
