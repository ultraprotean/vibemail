import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LandingPage from '@/app/page';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const auth = vi.hoisted(() => ({
  value: {
    status: 'signedOut' as 'loading' | 'signedOut' | 'signedIn',
    mock: false,
    startSample: vi.fn(),
    signInWithGoogle: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => auth.value }));

beforeEach(() => {
  router.replace.mockReset();
  router.push.mockReset();
  auth.value.status = 'signedOut';
  auth.value.mock = false;
  auth.value.startSample.mockReset();
  auth.value.signInWithGoogle.mockReset();
});

describe('landing page', () => {
  it('offers a pair of launch buttons, each explaining itself', () => {
    render(<LandingPage />);
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try the sample inbox' })).toBeInTheDocument();
    expect(screen.getByText(/Your real Gmail/)).toBeInTheDocument();
    expect(screen.getByText(/Pretend mail/)).toBeInTheDocument();
  });

  it('starts Google sign-in without touching the sample inbox', async () => {
    const user = userEvent.setup();
    render(<LandingPage />);
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(auth.value.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(auth.value.startSample).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('opens the sample inbox and goes to /inbox', async () => {
    const user = userEvent.setup();
    render(<LandingPage />);
    await user.click(screen.getByRole('button', { name: 'Try the sample inbox' }));
    expect(auth.value.startSample).toHaveBeenCalledTimes(1);
    expect(auth.value.signInWithGoogle).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith('/inbox');
  });

  it('sends a signed-in Gmail session straight to the inbox', () => {
    auth.value.status = 'signedIn';
    render(<LandingPage />);
    expect(router.replace).toHaveBeenCalledWith('/inbox');
  });

  it('still shows both buttons when a sample choice is remembered', () => {
    auth.value.status = 'signedIn';
    auth.value.mock = true;
    render(<LandingPage />);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try the sample inbox' })).toBeInTheDocument();
  });

  it('shows the reason a session ended, once', () => {
    window.sessionStorage.setItem('vibemail.signin-notice', 'Your session ended. Sign in again to continue.');
    render(<LandingPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended.');
    expect(window.sessionStorage.getItem('vibemail.signin-notice')).toBeNull();
  });
});
