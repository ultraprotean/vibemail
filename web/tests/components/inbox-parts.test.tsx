import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Highlight } from '@/components/Highlight';
import { LabelChips } from '@/components/LabelChips';
import { MessageRow } from '@/components/MessageRow';
import { buildHtmlDocument } from '@/components/ThreadView';
import type { Message } from '@/lib/types';

const message: Message = {
  id: 'm1',
  threadId: 't1',
  subject: 'Lantern parade',
  from: 'Marle <marle@truceinn.example>',
  to: 'you@vibemail.example',
  cc: null,
  snippet: 'Bring a cushion and a friend',
  bodyText: null,
  bodyHtml: null,
  isRead: false,
  receivedAt: '2026-01-01T12:00:00.000Z',
};

describe('LabelChips', () => {
  it('always renders All, Starred, Archive, Trash in order, then the Unread toggle', () => {
    render(<LabelChips unreadOnly={false} onToggleUnread={() => undefined} />);
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['All', 'Starred', 'Archive', 'Trash', 'Unread']);
  });

  it('keeps only All live; the rest are disabled and explain why', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<LabelChips unreadOnly={false} onToggleUnread={onToggle} />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    for (const name of ['Starred', 'Archive', 'Trash']) {
      const chip = screen.getByRole('button', { name });
      expect(chip).toHaveAttribute('aria-disabled', 'true');
      expect(chip).toHaveAccessibleDescription(/Needs backend support/);
      await user.click(chip);
    }
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('toggles the server-side unread filter', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<LabelChips unreadOnly={false} onToggleUnread={onToggle} />);
    await user.click(screen.getByRole('button', { name: 'Unread' }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

describe('MessageRow', () => {
  it('shows sender name, subject and snippet and marks unread mail', () => {
    const { container } = render(
      <ul>
        <MessageRow message={message} onOpen={() => undefined} onToggleRead={() => undefined} now={new Date('2026-01-01T18:00:00.000Z')} />
      </ul>,
    );
    expect(screen.getByText('Marle')).toBeInTheDocument();
    expect(screen.getByText('Lantern parade')).toBeInTheDocument();
    expect(screen.getByText('Bring a cushion and a friend')).toBeInTheDocument();
    expect(container.querySelector('li')).toHaveAttribute('data-unread', 'true');
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
  });

  it('offers Mark as unread on read mail and reports toggles and opens', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(
      <ul>
        <MessageRow message={{ ...message, isRead: true }} onOpen={onOpen} onToggleRead={onToggle} />
      </ul>,
    );
    await user.click(screen.getByRole('button', { name: 'Mark as unread' }));
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    await user.click(screen.getByRole('button', { name: /Open conversation/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1' }));
  });

  it('shows a placeholder for an empty subject and disables the toggle while pending', () => {
    render(
      <ul>
        <MessageRow message={{ ...message, subject: '' }} pending onOpen={() => undefined} onToggleRead={() => undefined} />
      </ul>,
    );
    expect(screen.getByText('(no subject)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeDisabled();
  });

  it('highlights search matches', () => {
    const { container } = render(
      <ul>
        <MessageRow message={message} query="cushion" onOpen={() => undefined} onToggleRead={() => undefined} />
      </ul>,
    );
    expect(container.querySelector('mark')?.textContent).toBe('cushion');
  });
});

describe('Highlight', () => {
  it('renders plain text for an empty query and marks every match otherwise', () => {
    const { container, rerender } = render(<p><Highlight text="a b a" query="" /></p>);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    rerender(<p><Highlight text="a b A" query="a" /></p>);
    expect(container.querySelectorAll('mark')).toHaveLength(2);
  });
});

describe('HTML mail sandbox document', () => {
  const csp = (doc: string) => /Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? '';

  it('loads https images by default but blocks everything else remote', () => {
    const policy = csp(buildHtmlDocument('<p>Hi</p>'));
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('img-src data: https:');
    expect(policy).not.toContain('script-src');
    expect(policy).not.toMatch(/http:(?!s)/);
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).toContain('font-src data:');
  });

  it('blocks remote images when the setting is off', () => {
    const policy = csp(buildHtmlDocument('<img src="https://x.example/p.png">', { remoteImages: false }));
    expect(policy).toContain('img-src data:');
    expect(policy).not.toContain('https:');
  });

  it('never sends the page address with image requests and keeps the message body', () => {
    const doc = buildHtmlDocument('<p>Hi</p>');
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc).toContain('<p>Hi</p>');
  });
});
