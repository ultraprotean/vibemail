'use client';

import { useRouter } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { InboxShell } from '@/components/InboxShell';
import { MailboxProvider } from '@/components/MailboxProvider';

function Opening() {
  return (
    <main id="main" className="signin" aria-busy="true">
      <p className="signin-text" role="status">
        Opening the inn…
      </p>
    </main>
  );
}

function InboxGate() {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'signedOut') router.replace('/');
  }, [status, router]);

  if (status !== 'signedIn') return <Opening />;
  return (
    <MailboxProvider>
      <InboxShell />
    </MailboxProvider>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={<Opening />}>
      <InboxGate />
    </Suspense>
  );
}
