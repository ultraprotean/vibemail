import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }));
const navigate = vi.hoisted(() => ({ navigateTo: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/navigate', () => navigate);

type AuthHook = typeof import('@/components/AuthProvider').useAuth;

async function loadAuth() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example');
  return import('@/components/AuthProvider');
}

function Probe({ useAuth }: { useAuth: AuthHook }) {
  const auth = useAuth();
  return (
    <div>
      <p data-testid="status">{auth.status}</p>
      <p data-testid="mock">{String(auth.mock)}</p>
      <button onClick={() => auth.expire(false)}>expire fatal</button>
      <button onClick={() => auth.expire(true)}>expire recoverable</button>
      <button onClick={() => auth.signOut()}>sign out</button>
      <button onClick={() => auth.startSample()}>start sample</button>
      <button onClick={() => auth.signInWithGoogle()}>sign in with google</button>
    </div>
  );
}

async function mount() {
  const { AuthProvider, useAuth } = await loadAuth();
  render(
    <AuthProvider>
      <Probe useAuth={useAuth} />
    </AuthProvider>,
  );
}

const status = () => screen.getByTestId('status');
const mockFlag = () => screen.getByTestId('mock');

beforeEach(() => {
  router.replace.mockReset();
  navigate.navigateTo.mockReset();
  window.history.replaceState(null, '', '/inbox');
});

describe('AuthProvider: real Gmail session', () => {
  it('captures #token=<jwt> from the OAuth redirect, stores it, remembers Gmail mode and strips the fragment', async () => {
    window.history.replaceState(null, '', '/inbox?thread=t1#token=header.payload.sig');
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedIn'));
    expect(mockFlag()).toHaveTextContent('false');
    expect(window.localStorage.getItem('vibemail.token')).toBe('header.payload.sig');
    expect(window.localStorage.getItem('vibemail.mode')).toBe('gmail');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/inbox?thread=t1');
  });

  it('a fresh Google sign-in wins over a remembered sample choice', async () => {
    window.localStorage.setItem('vibemail.mode', 'sample');
    window.history.replaceState(null, '', '/inbox#token=abc');
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedIn'));
    expect(mockFlag()).toHaveTextContent('false');
    expect(window.localStorage.getItem('vibemail.mode')).toBe('gmail');
  });

  it('is signed out when there is no token and no remembered mode', async () => {
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedOut'));
    expect(mockFlag()).toHaveTextContent('false');
  });

  it('stays signed in from a stored token', async () => {
    window.localStorage.setItem('vibemail.token', 'stored');
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedIn'));
    expect(mockFlag()).toHaveTextContent('false');
  });

  it('signInWithGoogle remembers Gmail mode and leaves for the API OAuth start endpoint', async () => {
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedOut'));
    act(() => screen.getByText('sign in with google').click());
    expect(window.localStorage.getItem('vibemail.mode')).toBe('gmail');
    expect(navigate.navigateTo).toHaveBeenCalledWith('https://api.example/api/v1/auth/google');
  });

  it('expire() clears the token and mode, leaves a notice for the landing page and redirects', async () => {
    window.localStorage.setItem('vibemail.token', 'stored');
    window.localStorage.setItem('vibemail.mode', 'gmail');
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedIn'));
    act(() => screen.getByText('expire fatal').click());
    await waitFor(() => expect(status()).toHaveTextContent('signedOut'));
    expect(window.localStorage.getItem('vibemail.token')).toBeNull();
    expect(window.localStorage.getItem('vibemail.mode')).toBeNull();
    expect(window.sessionStorage.getItem('vibemail.signin-notice')).toMatch(/revoked/i);
    expect(router.replace).toHaveBeenCalledWith('/');
  });

  it('expire(true) explains that the session ended', async () => {
    window.localStorage.setItem('vibemail.token', 'stored');
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedIn'));
    act(() => screen.getByText('expire recoverable').click());
    await waitFor(() => expect(window.sessionStorage.getItem('vibemail.signin-notice')).toMatch(/session ended/i));
  });

  it('signOut() clears the token and mode and returns to the landing page', async () => {
    window.localStorage.setItem('vibemail.token', 'stored');
    window.localStorage.setItem('vibemail.mode', 'gmail');
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedIn'));
    act(() => screen.getByText('sign out').click());
    await waitFor(() => expect(status()).toHaveTextContent('signedOut'));
    expect(window.localStorage.getItem('vibemail.token')).toBeNull();
    expect(window.localStorage.getItem('vibemail.mode')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/');
  });
});

describe('AuthProvider: sample inbox', () => {
  it('startSample() signs into the sample inbox and remembers the choice', async () => {
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedOut'));
    act(() => screen.getByText('start sample').click());
    await waitFor(() => expect(status()).toHaveTextContent('signedIn'));
    expect(mockFlag()).toHaveTextContent('true');
    expect(window.localStorage.getItem('vibemail.mode')).toBe('sample');
    expect(window.localStorage.getItem('vibemail.token')).toBeNull();
  });

  it('comes back in the sample inbox after a reload', async () => {
    window.localStorage.setItem('vibemail.mode', 'sample');
    await mount();
    await waitFor(() => expect(status()).toHaveTextContent('signedIn'));
    expect(mockFlag()).toHaveTextContent('true');
  });

  it('leaving the sample inbox forgets the choice', async () => {
    window.localStorage.setItem('vibemail.mode', 'sample');
    await mount();
    await waitFor(() => expect(mockFlag()).toHaveTextContent('true'));
    act(() => screen.getByText('sign out').click());
    await waitFor(() => expect(status()).toHaveTextContent('signedOut'));
    expect(mockFlag()).toHaveTextContent('false');
    expect(window.localStorage.getItem('vibemail.mode')).toBeNull();
    expect(router.replace).toHaveBeenCalledWith('/');
  });
});
