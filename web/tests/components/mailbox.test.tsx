import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailboxProvider, useMailbox } from '@/components/MailboxProvider';
import { ToastProvider } from '@/components/ToastProvider';
import { ApiError } from '@/lib/errors';
import type { ApiClient, Message, MessagePage } from '@/lib/types';

const hoisted = vi.hoisted(() => ({
  api: { listMessages: vi.fn(), sendMessage: vi.fn(), setReadState: vi.fn() },
  expire: vi.fn(),
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ status: 'signedIn', mock: false, api: hoisted.api as ApiClient, expire: hoisted.expire, signOut: vi.fn() }),
}));

function msg(n: number, extra: Partial<Message> = {}): Message {
  const id = `m${n}`;
  return {
    id,
    threadId: `t${n}`,
    subject: `Subject ${n}`,
    from: 'a@x.example',
    to: 'b@x.example',
    cc: null,
    snippet: '',
    bodyText: null,
    bodyHtml: null,
    isRead: false,
    receivedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    ...extra,
  };
}

const page = (messages: Message[], nextCursor: string | null = null): MessagePage => ({ messages, nextCursor });

let box: ReturnType<typeof useMailbox>;

function Harness() {
  box = useMailbox();
  return (
    <div>
      <p data-testid="phase">{box.phase}</p>
      <p data-testid="problem">{box.problem?.kind ?? 'none'}</p>
      <ul data-testid="list">
        {box.messages.map((m) => (
          <li key={m.id} data-read={m.isRead}>
            {m.id}
          </li>
        ))}
      </ul>
      <p data-testid="more">{String(box.hasMore)}</p>
    </div>
  );
}

function mount() {
  return render(
    <ToastProvider>
      <MailboxProvider>
        <Harness />
      </MailboxProvider>
    </ToastProvider>,
  );
}

const listText = () => screen.getByTestId('list').textContent;
const rows = () => Array.from(screen.getByTestId('list').querySelectorAll('li'));

beforeEach(() => {
  hoisted.api.listMessages.mockReset();
  hoisted.api.setReadState.mockReset();
  hoisted.expire.mockReset();
});

describe('MailboxProvider', () => {
  it('loads the first page and reports whether more exists', async () => {
    hoisted.api.listMessages.mockResolvedValue(page([msg(3), msg(2)], 'next'));
    mount();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('ready'));
    expect(listText()).toBe('m3m2');
    expect(screen.getByTestId('more')).toHaveTextContent('true');
    expect(hoisted.api.listMessages).toHaveBeenCalledWith({ limit: 20, unreadOnly: false });
  });

  it('shows a server problem when the first load fails with INTERNAL_ERROR, and recovers on reload', async () => {
    hoisted.api.listMessages.mockRejectedValueOnce(new ApiError('INTERNAL_ERROR', 'boom', 500));
    mount();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('error'));
    expect(screen.getByTestId('problem')).toHaveTextContent('server');

    hoisted.api.listMessages.mockResolvedValue(page([msg(1)]));
    act(() => box.reload());
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('ready'));
    expect(listText()).toBe('m1');
  });

  it('hands AUTH_FAILED to the session with the recoverable flag', async () => {
    hoisted.api.listMessages.mockRejectedValue(new ApiError('AUTH_FAILED', 'revoked', 401, false));
    mount();
    await waitFor(() => expect(hoisted.expire).toHaveBeenCalledWith(false));
  });

  it('loads more pages with the cursor', async () => {
    hoisted.api.listMessages.mockResolvedValueOnce(page([msg(3), msg(2)], 'c1'));
    mount();
    await waitFor(() => expect(listText()).toBe('m3m2'));
    hoisted.api.listMessages.mockResolvedValueOnce(page([msg(1)], null));
    act(() => box.loadMore());
    await waitFor(() => expect(listText()).toBe('m3m2m1'));
    expect(hoisted.api.listMessages).toHaveBeenLastCalledWith({ limit: 20, cursor: 'c1', unreadOnly: false });
    expect(screen.getByTestId('more')).toHaveTextContent('false');
  });

  it('restarts from the first page when Load more gets INVALID_REQUEST (stale cursor)', async () => {
    hoisted.api.listMessages.mockResolvedValueOnce(page([msg(3), msg(2)], 'stale'));
    mount();
    await waitFor(() => expect(listText()).toBe('m3m2'));
    hoisted.api.listMessages.mockRejectedValueOnce(new ApiError('INVALID_REQUEST', 'bad cursor', 400));
    hoisted.api.listMessages.mockResolvedValueOnce(page([msg(9), msg(8)], 'fresh'));
    act(() => box.loadMore());
    await waitFor(() => expect(listText()).toBe('m9m8'));
  });

  it('asks the server for unread mail when the Unread filter is on', async () => {
    hoisted.api.listMessages.mockResolvedValue(page([msg(2), msg(1)]));
    mount();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('ready'));
    hoisted.api.listMessages.mockResolvedValue(page([msg(2)]));
    act(() => box.setUnreadOnly(true));
    await waitFor(() => expect(listText()).toBe('m2'));
    expect(hoisted.api.listMessages).toHaveBeenLastCalledWith({ limit: 20, unreadOnly: true });
  });

  describe('read state', () => {
    beforeEach(async () => {
      hoisted.api.listMessages.mockResolvedValue(page([msg(2), msg(1, { isRead: true })]));
    });

    it('updates immediately and keeps the server answer', async () => {
      let resolve: (v: { id: string; isRead: boolean }) => void = () => undefined;
      hoisted.api.setReadState.mockReturnValue(new Promise((r) => (resolve = r)));
      mount();
      await waitFor(() => expect(listText()).toBe('m2m1'));

      let done: Promise<void> = Promise.resolve();
      act(() => {
        done = box.setRead('m2', true);
      });
      await waitFor(() => expect(rows()[0]).toHaveAttribute('data-read', 'true')); // optimistic
      expect(box.pending.has('m2')).toBe(true);
      await act(async () => {
        resolve({ id: 'm2', isRead: true });
        await done;
      });
      expect(hoisted.api.setReadState).toHaveBeenCalledWith('m2', true);
      expect(box.pending.has('m2')).toBe(false);
    });

    it('sends unread changes too', async () => {
      hoisted.api.setReadState.mockResolvedValue({ id: 'm1', isRead: false });
      mount();
      await waitFor(() => expect(listText()).toBe('m2m1'));
      await act(async () => {
        await box.setRead('m1', false);
      });
      expect(hoisted.api.setReadState).toHaveBeenCalledWith('m1', false);
      expect(rows()[1]).toHaveAttribute('data-read', 'false');
    });

    it('reverts on PROVIDER_ERROR and says so', async () => {
      hoisted.api.setReadState.mockRejectedValue(new ApiError('PROVIDER_ERROR', 'gmail', 502));
      mount();
      await waitFor(() => expect(listText()).toBe('m2m1'));
      await act(async () => {
        await box.setRead('m2', true);
      });
      expect(rows()[0]).toHaveAttribute('data-read', 'false');
      expect(await screen.findByText("Gmail didn't accept that change. Try again.")).toBeInTheDocument();
    });

    it('removes the row on NOT_FOUND', async () => {
      hoisted.api.setReadState.mockRejectedValue(new ApiError('NOT_FOUND', 'gone', 404));
      mount();
      await waitFor(() => expect(listText()).toBe('m2m1'));
      await act(async () => {
        await box.setRead('m2', true);
      });
      expect(listText()).toBe('m1');
      expect(await screen.findByText('That message is no longer in your mailbox.')).toBeInTheDocument();
    });

    it('reverts on INTERNAL_ERROR and hands AUTH_FAILED to the session', async () => {
      hoisted.api.setReadState.mockRejectedValueOnce(new ApiError('INTERNAL_ERROR', 'boom', 500));
      mount();
      await waitFor(() => expect(listText()).toBe('m2m1'));
      await act(async () => {
        await box.setRead('m2', true);
      });
      expect(rows()[0]).toHaveAttribute('data-read', 'false');
      expect(await screen.findByText("That didn't work. Try again.")).toBeInTheDocument();

      hoisted.api.setReadState.mockRejectedValueOnce(new ApiError('AUTH_FAILED', 'expired', 401, true));
      await act(async () => {
        await box.setRead('m2', true);
      });
      expect(hoisted.expire).toHaveBeenCalledWith(true);
    });

    it('marks every unread message in a thread read', async () => {
      hoisted.api.listMessages.mockResolvedValue(
        page([msg(3, { threadId: 'tx' }), msg(2, { threadId: 'tx', isRead: true }), msg(1, { threadId: 'tx' })]),
      );
      hoisted.api.setReadState.mockImplementation(async (id: string) => ({ id, isRead: true }));
      mount();
      await waitFor(() => expect(listText()).toBe('m3m2m1'));
      await act(async () => {
        await box.markThreadRead('tx');
      });
      expect(hoisted.api.setReadState).toHaveBeenCalledTimes(2);
      expect(hoisted.api.setReadState).toHaveBeenCalledWith('m3', true);
      expect(hoisted.api.setReadState).toHaveBeenCalledWith('m1', true);
    });
  });

  describe('finding a thread outside the loaded list', () => {
    it('pages the unfiltered pool until the thread turns up', async () => {
      hoisted.api.listMessages.mockResolvedValueOnce(page([msg(3), msg(2)], 'c1')); // inbox first page
      mount();
      await waitFor(() => expect(listText()).toBe('m3m2'));

      hoisted.api.listMessages.mockResolvedValueOnce(page([msg(3), msg(2)], 'p1')); // pool page 1: no t1 yet
      hoisted.api.listMessages.mockResolvedValueOnce(page([msg(1)], null)); // pool page 2: found
      let result = '';
      await act(async () => {
        result = await box.findThread('t1');
      });
      expect(result).toBe('found');
      expect(hoisted.api.listMessages).toHaveBeenCalledWith({ limit: 100, cursor: undefined });
      expect(hoisted.api.listMessages).toHaveBeenCalledWith({ limit: 100, cursor: 'p1' });
    });

    it('reports missing when the mailbox runs out', async () => {
      hoisted.api.listMessages.mockResolvedValueOnce(page([msg(3)], null));
      mount();
      await waitFor(() => expect(listText()).toBe('m3'));
      hoisted.api.listMessages.mockResolvedValueOnce(page([msg(3)], null));
      let result = '';
      await act(async () => {
        result = await box.findThread('nope');
      });
      expect(result).toBe('missing');
    });

    it('reports failed when paging errors', async () => {
      hoisted.api.listMessages.mockResolvedValueOnce(page([msg(3)], 'c'));
      mount();
      await waitFor(() => expect(listText()).toBe('m3'));
      hoisted.api.listMessages.mockRejectedValueOnce(new ApiError('INTERNAL_ERROR', 'boom', 500));
      let result = '';
      await act(async () => {
        result = await box.findThread('nope');
      });
      expect(result).toBe('failed');
    });
  });
});
