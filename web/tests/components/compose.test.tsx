import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeDrawer, type ComposeMode, type DraftFields } from '@/components/ComposeDrawer';
import { ToastProvider } from '@/components/ToastProvider';
import { ApiError, NetworkError } from '@/lib/errors';
import { loadDraft, saveDraft } from '@/lib/drafts';
import type { Message } from '@/lib/types';

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn(), expire: vi.fn() }));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    status: 'signedIn',
    mock: false,
    signOut: vi.fn(),
    expire: mocks.expire,
    api: { sendMessage: mocks.sendMessage, listMessages: vi.fn(), setReadState: vi.fn() },
  }),
}));

const EMPTY: DraftFields = { to: [], cc: [], bcc: [], subject: '', bodyText: '' };

const original: Message = {
  id: 'm1',
  threadId: 'thread-9',
  subject: 'Hello there',
  from: 'Marle <marle@truceinn.example>',
  to: 'you@vibemail.example',
  cc: null,
  snippet: 'Short snippet',
  bodyText: 'The original message body.',
  bodyHtml: null,
  isRead: true,
  receivedAt: '2026-01-01T00:00:00.000Z',
};

interface Options {
  mode?: ComposeMode;
  replyTo?: Message;
  initial?: DraftFields;
  draftKey?: string;
}

function setup(options: Options = {}) {
  const onClose = vi.fn();
  const onSent = vi.fn();
  const onDiscard = vi.fn();
  render(
    <ToastProvider>
      <ComposeDrawer
        mode={options.mode ?? 'new'}
        replyTo={options.replyTo}
        initial={options.initial ?? EMPTY}
        draftKey={options.draftKey ?? 'new'}
        onClose={onClose}
        onSent={onSent}
        onDiscard={onDiscard}
      />
    </ToastProvider>,
  );
  return { onClose, onSent, onDiscard, user: userEvent.setup() };
}

const replyInitial: DraftFields = { to: ['marle@truceinn.example'], cc: [], bcc: [], subject: 'Re: Hello there', bodyText: '' };

beforeEach(() => {
  mocks.sendMessage.mockReset();
  mocks.expire.mockReset();
});

describe('default mode (new message)', () => {
  it('starts empty and titled New message', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'New message' })).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/attach/i)).not.toBeInTheDocument();
  });

  it('validates on submit, not on blur', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('To'), 'not-an-address');
    await user.tab();
    expect(screen.queryByText(/doesn't look like an email address/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/"not-an-address" doesn't look like an email address/)).toBeInTheDocument();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('requires a recipient, a subject and a body', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Add at least one recipient.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('To'), 'a@x.example{Enter}');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Give it a subject.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Subject'), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Write a message first.')).toBeInTheDocument();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('sends the contract request body and finishes', async () => {
    mocks.sendMessage.mockResolvedValue({ id: 's1', threadId: 't1', status: 'sent' });
    const { user, onSent } = setup();
    await user.type(screen.getByLabelText('To'), 'a@x.example, b@x.example{Enter}');
    await user.type(screen.getByLabelText('Subject'), 'Lanterns');
    await user.type(screen.getByLabelText('Message'), 'See you at dusk');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(mocks.sendMessage).toHaveBeenCalledWith({ to: ['a@x.example', 'b@x.example'], subject: 'Lanterns', bodyText: 'See you at dusk' });
    expect(loadDraft('new')).toBeNull();
  });

  it('includes Cc and Bcc only when filled in', async () => {
    mocks.sendMessage.mockResolvedValue({ id: 's1', threadId: 't1', status: 'sent' });
    const { user } = setup();
    await user.type(screen.getByLabelText('To'), 'a@x.example{Enter}');
    await user.click(screen.getByRole('button', { name: 'Add Cc' }));
    await user.type(screen.getByLabelText('Cc'), 'c@x.example{Enter}');
    await user.type(screen.getByLabelText('Subject'), 'S');
    await user.type(screen.getByLabelText('Message'), 'B');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());
    expect(mocks.sendMessage).toHaveBeenCalledWith({ to: ['a@x.example'], cc: ['c@x.example'], subject: 'S', bodyText: 'B' });
  });
});

describe('reply mode', () => {
  it('fixes the recipient, prefixes the subject once, quotes the original at reduced weight and sends the threadId', async () => {
    mocks.sendMessage.mockResolvedValue({ id: 's1', threadId: 'thread-9', status: 'sent' });
    const { user, onSent } = setup({ mode: 'reply', replyTo: original, initial: replyInitial, draftKey: 'reply:thread-9' });

    expect(screen.getByRole('heading', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.getByText('marle@truceinn.example')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove marle/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Re: Hello there');
    expect(screen.getByText('The original message body.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Message'), 'Thanks!');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      to: ['marle@truceinn.example'],
      subject: 'Re: Hello there',
      bodyText: 'Thanks!',
      threadId: 'thread-9',
    });
  });

  it('quotes the snippet when there is no plain-text body', () => {
    setup({ mode: 'reply', replyTo: { ...original, bodyText: null }, initial: replyInitial, draftKey: 'reply:thread-9' });
    expect(screen.getByText('Short snippet')).toBeInTheDocument();
  });
});

describe('draft-restored mode', () => {
  const restored: DraftFields = { to: ['a@x.example'], cc: [], bcc: [], subject: 'Unfinished', bodyText: 'Half a thought' };

  it('prefills the fields, says Draft restored and offers Discard draft', async () => {
    const { user, onDiscard } = setup({ mode: 'draft-restored', initial: restored });
    expect(screen.getByRole('heading', { name: 'Draft restored' })).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Unfinished');
    expect(screen.getByLabelText('Message')).toHaveValue('Half a thought');
    expect(screen.getByText('a@x.example')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(onDiscard).toHaveBeenCalled();
  });

  it('keeps the draft when closed', async () => {
    const { user, onClose } = setup({ mode: 'draft-restored', initial: restored });
    await user.click(screen.getByRole('button', { name: 'Close and keep draft' }));
    expect(onClose).toHaveBeenCalled();
    expect(loadDraft('new')).toMatchObject({ subject: 'Unfinished', bodyText: 'Half a thought' });
  });
});

describe('send errors', () => {
  async function fillAndSend(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('To'), 'a@x.example{Enter}');
    await user.type(screen.getByLabelText('Subject'), 'S');
    await user.type(screen.getByLabelText('Message'), 'B');
    await user.click(screen.getByRole('button', { name: 'Send' }));
  }

  it('INVALID_REQUEST shows the server message and keeps the draft', async () => {
    mocks.sendMessage.mockRejectedValue(new ApiError('INVALID_REQUEST', 'to contains an invalid address: a@x.example', 400));
    const { user, onSent } = setup();
    await fillAndSend(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('to contains an invalid address');
    expect(onSent).not.toHaveBeenCalled();
    expect(loadDraft('new')).toMatchObject({ subject: 'S', bodyText: 'B' });
  });

  it('PROVIDER_ERROR says the draft is safe', async () => {
    mocks.sendMessage.mockRejectedValue(new ApiError('PROVIDER_ERROR', 'gmail failed', 502));
    const { user } = setup();
    await fillAndSend(user);
    expect(await screen.findByRole('alert')).toHaveTextContent("Gmail couldn't send that. Your draft is safe. Try again.");
  });

  it('RATE_LIMITED disables Send with a countdown', async () => {
    mocks.sendMessage.mockRejectedValue(new ApiError('RATE_LIMITED', 'slow', 429));
    const { user } = setup();
    await fillAndSend(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Gmail asked us to slow down.');
    const button = screen.getByRole('button', { name: /Wait \d+s/ });
    expect(button).toBeDisabled();
  });

  it('INTERNAL_ERROR and a missing response each say the draft is safe', async () => {
    mocks.sendMessage.mockRejectedValueOnce(new ApiError('INTERNAL_ERROR', 'boom', 500));
    const { user } = setup();
    await fillAndSend(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side. Your draft is safe.');

    mocks.sendMessage.mockRejectedValueOnce(new NetworkError());
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Can't reach VibeMail. Your draft is safe."));
  });

  it('AUTH_FAILED saves the draft and hands over to sign-in with the recoverable flag', async () => {
    mocks.sendMessage.mockRejectedValue(new ApiError('AUTH_FAILED', 'expired', 401, true));
    const { user } = setup();
    await fillAndSend(user);
    await waitFor(() => expect(mocks.expire).toHaveBeenCalledWith(true));
    expect(loadDraft('new')).toMatchObject({ subject: 'S', bodyText: 'B', to: ['a@x.example'] });
  });

  it('cannot be closed while a send is in flight', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.sendMessage.mockReturnValue(new Promise((r) => (resolve = r)));
    const { user, onClose } = setup();
    await fillAndSend(user);
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    resolve({ id: 's', threadId: 't', status: 'sent' });
  });
});

describe('saved drafts from earlier sessions', () => {
  it('are readable by the loader', () => {
    saveDraft('reply:thread-9', { ...EMPTY, to: ['a@x.example'], subject: 'Re: x', bodyText: 'draft' });
    expect(loadDraft('reply:thread-9')?.bodyText).toBe('draft');
  });
});
