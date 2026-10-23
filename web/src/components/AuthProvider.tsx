'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient, loginUrl } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { signInNotice } from '@/lib/errors';
import { createMockClient } from '@/lib/mock';
import { navigateTo } from '@/lib/navigate';
import { clearMode, clearToken, readMode, readToken, setNotice, tokenFromHash, writeMode, writeToken } from '@/lib/token';
import type { ApiClient } from '@/lib/types';

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: AuthStatus;
  /** True while running on the built-in sample inbox (no API, no sign-in). */
  mock: boolean;
  api: ApiClient;
  /** Landing page: open the built-in sample inbox. */
  startSample: () => void;
  /** Landing page: send the browser to Google through the API's OAuth start endpoint. */
  signInWithGoogle: () => void;
  /** Leave the current mode (clears the token and the remembered mode) and return to the landing page. */
  signOut: () => void;
  /** An `AUTH_FAILED` came back: clear the session and explain on the landing page. */
  expire: (recoverable: boolean | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [mock, setMock] = useState(false);
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    // CONTRACT.md §6.2: the API redirects to <FRONTEND_URL>/inbox#token=<jwt>.
    const fromHash = tokenFromHash(window.location.hash);
    if (fromHash) {
      writeToken(fromHash);
      writeMode('gmail');
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    tokenRef.current = fromHash ?? readToken();
    if (!fromHash && readMode() === 'sample') {
      setMock(true);
      setStatus('signedIn');
      return;
    }
    setMock(false);
    setStatus(tokenRef.current ? 'signedIn' : 'signedOut');
  }, []);

  const api = useMemo<ApiClient>(
    () => (mock ? createMockClient() : createApiClient({ baseUrl: API_URL, getToken: () => tokenRef.current })),
    [mock],
  );

  const startSample = useCallback(() => {
    writeMode('sample');
    setMock(true);
    setStatus('signedIn');
  }, []);

  const signInWithGoogle = useCallback(() => {
    writeMode('gmail');
    navigateTo(loginUrl(API_URL));
  }, []);

  const leave = useCallback(() => {
    clearToken();
    clearMode();
    tokenRef.current = null;
    setMock(false);
    setStatus('signedOut');
  }, []);

  const signOut = useCallback(() => {
    leave();
    router.replace('/');
  }, [leave, router]);

  const expire = useCallback(
    (recoverable: boolean | null) => {
      leave();
      setNotice(signInNotice(recoverable));
      router.replace('/');
    },
    [leave, router],
  );

  const value = useMemo(
    () => ({ status, mock, api, startSample, signInWithGoogle, signOut, expire }),
    [status, mock, api, startSample, signInWithGoogle, signOut, expire],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
