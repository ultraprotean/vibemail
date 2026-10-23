import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsProvider } from '@/components/SettingsProvider';
import { MessageBody } from '@/components/ThreadView';
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from '@/lib/settings';
import type { Message } from '@/lib/types';

const base: Message = {
  id: 'm1',
  threadId: 't1',
  subject: 'Newsletter',
  from: 'Shop <shop@x.example>',
  to: 'you@x.example',
  cc: null,
  snippet: 'a snippet',
  bodyText: 'Plain words',
  bodyHtml: '<p>Fancy <img src="https://cdn.example/banner.png" alt="banner"></p>',
  isRead: true,
  receivedAt: '2026-01-01T00:00:00.000Z',
};

function mount(message: Partial<Message> = {}, settings: Partial<Settings> = {}) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }));
  render(
    <SettingsProvider>
      <MessageBody message={{ ...base, ...message }} />
    </SettingsProvider>,
  );
  return userEvent.setup();
}

const frame = () => screen.queryByTitle('Message from Shop') as HTMLIFrameElement | null;
const policy = () => /Content-Security-Policy" content="([^"]*)"/.exec(frame()?.getAttribute('srcdoc') ?? '')?.[1] ?? '';

beforeEach(() => {
  window.localStorage.clear();
});

describe('MessageBody: which version shows first', () => {
  it('shows HTML by default when a message has both HTML and plain text', () => {
    mount();
    expect(frame()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'HTML' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Plain' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Plain words')).not.toBeInTheDocument();
  });

  it('shows plain text by default only when there is no HTML', () => {
    mount({ bodyHtml: null });
    expect(frame()).not.toBeInTheDocument();
    expect(screen.getByText('Plain words')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'HTML' })).toBeDisabled();
  });

  it('shows HTML when the message has no plain text', () => {
    mount({ bodyText: null });
    expect(frame()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plain' })).toBeDisabled();
  });

  it('lets the reader switch to plain text and back', async () => {
    const user = mount();
    await user.click(screen.getByRole('button', { name: 'Plain' }));
    expect(screen.getByText('Plain words')).toBeInTheDocument();
    expect(frame()).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'HTML' }));
    expect(frame()).toBeInTheDocument();
  });

  it('falls back to the snippet when there is no body at all', () => {
    mount({ bodyText: null, bodyHtml: null });
    expect(screen.getByText('a snippet')).toBeInTheDocument();
  });
});

describe('MessageBody: images', () => {
  it('loads remote images by default and shows no warning', () => {
    mount();
    expect(policy()).toContain('img-src data: https:');
    expect(screen.queryByText(/Remote images are blocked/)).not.toBeInTheDocument();
  });

  it('blocks them when Settings says so, and offers to load them for one message', async () => {
    const user = mount({}, { remoteImages: false });
    expect(policy()).toContain('img-src data:');
    expect(policy()).not.toContain('https:');
    expect(screen.getByText(/Remote images are blocked/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load images for this message' }));
    expect(policy()).toContain('img-src data: https:');
    expect(screen.queryByText(/Remote images are blocked/)).not.toBeInTheDocument();
  });

  it('does not mention images when the message has none', () => {
    mount({ bodyHtml: '<p>Just words</p>' }, { remoteImages: false });
    expect(screen.queryByText(/Remote images are blocked/)).not.toBeInTheDocument();
  });

  it('never allows scripts or other remote content', () => {
    mount();
    expect(frame()).toHaveAttribute('sandbox', expect.not.stringContaining('allow-scripts'));
    expect(policy()).toContain("default-src 'none'");
  });
});
