import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/nunito';
import '@fontsource-variable/pixelify-sans';
import '@/styles/tokens.css';
import '@/styles/themes.css';
import '@/styles/patterns.css';
import '@/styles/app.css';
import { Providers } from '@/components/Providers';
import { NO_FLASH_SCRIPT } from '@/lib/settings';

export const metadata: Metadata = {
  title: 'VibeMail Cozy',
  description: 'A cozy place for your Gmail.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-visual',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="hearthside" data-pattern="grain" data-motion="on" data-drift="on" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to mail
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
