'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from './AuthProvider';
import { Backdrop } from './Backdrop';
import { SettingsProvider } from './SettingsProvider';
import { ToastProvider } from './ToastProvider';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <Backdrop />
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
