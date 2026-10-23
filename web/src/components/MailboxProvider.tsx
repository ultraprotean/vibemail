'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MAX_WIDE_PAGES, PAGE_SIZE, REFRESH_INTERVAL_MS, WIDE_PAGE_SIZE } from '@/lib/config';
import { ApiError, NetworkError, isAuthFailed } from '@/lib/errors';
import {
  EMPTY_MAILBOX,
  applyFirstPage,
  applyMorePage,
  applyPoolPage,
  applyRefreshedPage,
  listMessages,
  patchMessage,
  removeMessage,
  type MailboxData,
} from '@/lib/mailbox-state';
import type { Message } from '@/lib/types';
import { useAuth } from './AuthProvider';
import { useToast } from './ToastProvider';

export type Phase = 'loading' | 'ready' | 'error';

export interface ListProblem {
  kind: 'network' | 'server';
  message: string;
}

export type ThreadLookup = 'found' | 'missing' | 'failed';

interface MailboxContextValue {
  messages: Message[];
  /** Every message fetched so far, for thread view and search. */
  pool: Message[];
  phase: Phase;
  problem: ListProblem | null;
  loadingMore: boolean;
  hasMore: boolean;
  unreadOnly: boolean;
  setUnreadOnly: (value: boolean) => void;
  pending: ReadonlySet<string>;
  reload: () => void;
  loadMore: () => void;
  setRead: (id: string, isRead: boolean) => Promise<void>;
  markThreadRead: (threadId: string) => Promise<void>;
  /** Load the unfiltered pool one wide page further. Resolves true when more pages remain. */
  loadOlder: () => Promise<{ ok: boolean; more: boolean }>;
  olderPagesLoaded: number;
  widening: boolean;
  findThread: (threadId: string) => Promise<ThreadLookup>;
  afterSend: () => void;
}

const MailboxContext = createContext<MailboxContextValue | null>(null);

function problemFrom(error: unknown): ListProblem {
  if (error instanceof NetworkError) return { kind: 'network', message: "Can't reach VibeMail right now." };
  return { kind: 'server', message: 'Something went wrong on our side.' };
}

export function MailboxProvider({ children }: { children: ReactNode }) {
  const { api, expire } = useAuth();
  const toast = useToast();

  const [data, setData] = useState<MailboxData>(EMPTY_MAILBOX);
  const [phase, setPhase] = useState<Phase>('loading');
  const [problem, setProblem] = useState<ListProblem | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unreadOnly, setUnreadOnlyState] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [widening, setWidening] = useState(false);
  const [olderPagesLoaded, setOlderPagesLoaded] = useState(0);

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  // The ref is the source of truth: async loops (thread lookup) must see their own writes
  // before React re-renders, so every change goes through updateData.
  const dataRef = useRef<MailboxData>(EMPTY_MAILBOX);
  const updateData = useCallback((change: (current: MailboxData) => MailboxData) => {
    dataRef.current = change(dataRef.current);
    setData(dataRef.current);
  }, []);
  const unreadOnlyRef = useRef(unreadOnly);
  unreadOnlyRef.current = unreadOnly;
  const requestGeneration = useRef(0);
  const wideInFlight = useRef<Promise<{ ok: boolean; more: boolean }> | null>(null);

  const handleAuth = useCallback(
    (error: unknown): boolean => {
      if (isAuthFailed(error)) {
        expire(error.recoverable);
        return true;
      }
      return false;
    },
    [expire],
  );

  const loadFirst = useCallback(
    async (mode: 'fresh' | 'silent') => {
      const generation = ++requestGeneration.current;
      if (mode === 'fresh') {
        setPhase('loading');
        setProblem(null);
      }
      try {
        const page = await api.listMessages({ limit: PAGE_SIZE, unreadOnly: unreadOnlyRef.current });
        if (generation !== requestGeneration.current) return;
        updateData((current) =>
          mode === 'fresh' ? applyFirstPage(current, page, pendingRef.current) : applyRefreshedPage(current, page, pendingRef.current),
        );
        setPhase('ready');
        setProblem(null);
      } catch (error) {
        if (generation !== requestGeneration.current) return;
        if (handleAuth(error)) return;
        if (error instanceof ApiError && error.code === 'INVALID_REQUEST' && mode === 'silent') return;
        if (mode === 'silent' && dataRef.current.listIds.length > 0) return; // keep what we have; try again later
        setPhase('error');
        setProblem(problemFrom(error));
      }
    },
    [api, handleAuth, updateData],
  );

  // First load, and every time the Unread filter changes: restart from the first page.
  useEffect(() => {
    updateData((current) => ({ ...current, listIds: [], listCursor: null }));
    void loadFirst('fresh');
  }, [unreadOnly, loadFirst]);

  // Refresh the first page on focus and on a timer (our API only, never Gmail).
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible' && phase === 'ready') void loadFirst('silent');
    };
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [phase, loadFirst]);

  const loadMore = useCallback(() => {
    const cursor = dataRef.current.listCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api
      .listMessages({ limit: PAGE_SIZE, cursor, unreadOnly: unreadOnlyRef.current })
      .then((page) => updateData((current) => applyMorePage(current, page, pendingRef.current)))
      .catch((error: unknown) => {
        if (handleAuth(error)) return;
        if (error instanceof ApiError && error.code === 'INVALID_REQUEST') {
          void loadFirst('fresh'); // stale or malformed cursor: start over from page one
          return;
        }
        toast.show(error instanceof NetworkError ? "Can't reach VibeMail right now." : 'Could not load more mail. Try again.', 'warning');
      })
      .finally(() => setLoadingMore(false));
  }, [api, handleAuth, loadFirst, loadingMore, toast, updateData]);

  const setUnreadOnly = useCallback((value: boolean) => setUnreadOnlyState(value), []);

  const setRead = useCallback(
    async (id: string, isRead: boolean) => {
      const before = dataRef.current.byId[id];
      if (!before || before.isRead === isRead || pendingRef.current.has(id)) return;
      setPending((current) => new Set(current).add(id));
      updateData((current) => patchMessage(current, id, { isRead }));
      try {
        const result = await api.setReadState(id, isRead);
        updateData((current) => patchMessage(current, id, { isRead: result.isRead }));
      } catch (error) {
        updateData((current) => patchMessage(current, id, { isRead: before.isRead }));
        if (handleAuth(error)) return;
        if (error instanceof ApiError && error.code === 'NOT_FOUND') {
          updateData((current) => removeMessage(current, id));
          toast.show('That message is no longer in your mailbox.', 'warning');
        } else if (error instanceof ApiError && error.code === 'PROVIDER_ERROR') {
          toast.show("Gmail didn't accept that change. Try again.", 'warning');
        } else if (error instanceof NetworkError) {
          toast.show("Can't reach VibeMail right now.", 'warning');
        } else {
          toast.show("That didn't work. Try again.", 'warning');
        }
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [api, handleAuth, toast, updateData],
  );

  const markThreadRead = useCallback(
    async (threadId: string) => {
      const unread = Object.values(dataRef.current.byId).filter((m) => m.threadId === threadId && !m.isRead);
      await Promise.all(unread.map((m) => setRead(m.id, true)));
    },
    [setRead],
  );

  const loadOlder = useCallback((): Promise<{ ok: boolean; more: boolean }> => {
    if (wideInFlight.current) return wideInFlight.current;
    const cursor = dataRef.current.poolCursor;
    if (cursor === null) return Promise.resolve({ ok: true, more: false });
    setWidening(true);
    const run = api
      .listMessages({ limit: WIDE_PAGE_SIZE, cursor: cursor ?? undefined })
      .then((page) => {
        updateData((current) => applyPoolPage(current, page, pendingRef.current));
        setOlderPagesLoaded((n) => n + 1);
        return { ok: true, more: page.nextCursor !== null };
      })
      .catch((error: unknown) => {
        handleAuth(error);
        return { ok: false, more: true };
      })
      .finally(() => {
        wideInFlight.current = null;
        setWidening(false);
      });
    wideInFlight.current = run;
    return run;
  }, [api, handleAuth, updateData]);

  const findThread = useCallback(
    async (threadId: string): Promise<ThreadLookup> => {
      const has = () => Object.values(dataRef.current.byId).some((m) => m.threadId === threadId);
      if (has()) return 'found';
      for (let page = 0; page < MAX_WIDE_PAGES; page += 1) {
        const result = await loadOlder();
        if (!result.ok) return 'failed';
        if (has()) return 'found';
        if (!result.more) break;
      }
      return 'missing';
    },
    [loadOlder],
  );

  const reload = useCallback(() => void loadFirst('fresh'), [loadFirst]);
  const afterSend = useCallback(() => void loadFirst('silent'), [loadFirst]);

  const messages = useMemo(() => listMessages(data), [data]);
  const pool = useMemo(() => Object.values(data.byId), [data.byId]);

  const value = useMemo<MailboxContextValue>(
    () => ({
      messages,
      pool,
      phase,
      problem,
      loadingMore,
      hasMore: data.listCursor !== null,
      unreadOnly,
      setUnreadOnly,
      pending,
      reload,
      loadMore,
      setRead,
      markThreadRead,
      loadOlder,
      olderPagesLoaded,
      widening,
      findThread,
      afterSend,
    }),
    [
      messages,
      pool,
      phase,
      problem,
      loadingMore,
      data.listCursor,
      unreadOnly,
      setUnreadOnly,
      pending,
      reload,
      loadMore,
      setRead,
      markThreadRead,
      loadOlder,
      olderPagesLoaded,
      widening,
      findThread,
      afterSend,
    ],
  );

  return <MailboxContext.Provider value={value}>{children}</MailboxContext.Provider>;
}

export function useMailbox(): MailboxContextValue {
  const ctx = useContext(MailboxContext);
  if (!ctx) throw new Error('useMailbox must be used inside MailboxProvider');
  return ctx;
}
