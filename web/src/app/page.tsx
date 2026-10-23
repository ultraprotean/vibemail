'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { takeNotice } from '@/lib/token';

export default function LandingPage() {
  const router = useRouter();
  const { status, mock, startSample, signInWithGoogle } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // React Strict Mode runs effects twice in development: the second run finds the notice already taken.
    const pending = takeNotice();
    if (pending) setNotice(pending);
  }, []);

  // A real session in progress goes straight to the inbox; a remembered sample choice still shows both buttons.
  useEffect(() => {
    if (status === 'signedIn' && !mock) router.replace('/inbox');
  }, [status, mock, router]);

  function launchSample() {
    startSample();
    router.push('/inbox');
  }

  return (
    <main id="main" className="signin">
      <div className="signin-card">
        <div className="signin-art" aria-hidden="true" />
        <h1>VibeMail</h1>
        <p className="signin-tag">A cozy corner for your Gmail.</p>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}

        <div className="launch" role="group" aria-label="Choose how to start">
          <div className="launch-option">
            <button type="button" className="button button-primary" onClick={signInWithGoogle}>
              Sign in with Google
            </button>
            <p className="launch-note">Your real Gmail, kept in sync by VibeMail.</p>
          </div>
          <div className="launch-or" aria-hidden="true">
            <span>or</span>
          </div>
          <div className="launch-option">
            <button type="button" className="button" onClick={launchSample}>
              Try the sample inbox
            </button>
            <p className="launch-note">Pretend mail to explore. No account, nothing leaves this browser.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
