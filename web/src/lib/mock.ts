import { ApiError, NetworkError, type ApiErrorCode } from './errors';
import { sortNewestFirst } from './threads';
import type { ApiClient, ListParams, Message, MessagePage, ReadResponse, SendRequest, SendResponse } from './types';

/**
 * Sample-data client (chosen with "Try the sample inbox" on the landing page). Implements the same ApiClient as the real
 * one, so every view can be exercised without Google OAuth. URL flags make states testable:
 *   ?mockFail=INTERNAL_ERROR | AUTH_FAILED | AUTH_FAILED_FATAL | NETWORK | ...   fail operations
 *   &mockOp=list | send | read                                                   limit failures to one op
 *   ?mockEmpty=1                                                                 empty mailbox
 *   ?mockSlow=1200                                                               add latency (ms)
 */

export const MOCK_ME = 'You <you@vibemail.example>';

interface Seed {
  thread: string;
  from: string;
  to?: string;
  cc?: string | null;
  subject: string;
  snippet: string;
  bodyText: string | null;
  bodyHtml?: string | null;
  minutesAgo: number;
  read: boolean;
}

const ME = MOCK_ME;

const SEEDS: Seed[] = [
  { thread: 't-inn', from: 'Marle <marle@truceinn.example>', subject: 'Your room at the Truce Inn', snippet: 'We have kept the window room for you, the one that looks over the festival square.', bodyText: 'Hello!\n\nWe have kept the window room for you, the one that looks over the festival square. Breakfast is served until ten, and there is fresh bread most mornings.\n\nTell us roughly when you will arrive and we will light the lamp.\n\nMarle', minutesAgo: 14, read: false },
  { thread: 't-inn', from: ME, to: 'Marle <marle@truceinn.example>', subject: 'Re: Your room at the Truce Inn', snippet: 'Thank you, that sounds perfect. We should arrive near sunset.', bodyText: 'Thank you, that sounds perfect. We should arrive near sunset.\n\nIs there a stable for one very tired horse?', minutesAgo: 190, read: true },
  { thread: 't-inn', from: 'Marle <marle@truceinn.example>', subject: 'Your room at the Truce Inn', snippet: 'Welcome to Truce! Here is everything you need to plan your stay.', bodyText: 'Welcome to Truce!\n\nHere is everything you need to plan your stay: check-in opens at noon, the kitchen closes at nine, and the stable is behind the well.', minutesAgo: 1450, read: true },
  { thread: 't-fest', from: 'Leene Square Gazette <news@leene-gazette.example>', subject: 'This week: Millennial Fair lantern parade', snippet: 'Lanterns, music and a very suspicious pendant stall. Everything happening this week.', bodyText: null, bodyHtml: '<img alt="Paper lanterns over the square" width="320" height="96" style="display:block;max-width:100%;height:auto;border-radius:8px;margin-bottom:8px" src="data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 320 96%27%3E%3Crect width=%27320%27 height=%2796%27 fill=%27%23f3d9a4%27/%3E%3Cg stroke=%27%237a4f24%27 stroke-width=%273%27%3E%3Cpath d=%27M0 18 Q160 52 320 18%27 fill=%27none%27/%3E%3C/g%3E%3Cg fill=%27%23d9822b%27 stroke=%27%237a4f24%27 stroke-width=%272%27%3E%3Crect x=%2744%27 y=%2740%27 width=%2724%27 height=%2732%27 rx=%278%27/%3E%3Crect x=%27148%27 y=%2748%27 width=%2724%27 height=%2732%27 rx=%278%27/%3E%3Crect x=%27252%27 y=%2740%27 width=%2724%27 height=%2732%27 rx=%278%27/%3E%3C/g%3E%3C/svg%3E"><h2 style="font-family:sans-serif">Millennial Fair</h2><p style="font-family:sans-serif">Lanterns, music and a very suspicious pendant stall. <b>Everything</b> happening this week, in one place.</p><ul style="font-family:sans-serif"><li>Lantern parade, 7pm</li><li>Cooking contest, noon</li><li>Pendant stall (be careful)</li></ul>', minutesAgo: 52, read: false },
  { thread: 't-guild', from: 'Lucca Ashtear <lucca@inventors.example>', cc: 'Robo <robo@inventors.example>', subject: 'Gadget review: the new time-keeper prototype', snippet: 'I rebuilt the gate mechanism and it finally holds. Could you look it over before Friday?', bodyText: 'I rebuilt the gate mechanism and it finally holds. Could you look it over before Friday?\n\nRobo already ran the numbers and says the margins are comfortable, but I would feel better with a second pair of eyes.\n\nLucca', minutesAgo: 95, read: false },
  { thread: 't-bank', from: 'Kupo Bank <statements@kupobank.example>', subject: 'Your monthly statement is ready', snippet: 'Your statement for the month is available. Balance: 4,210 gil. No action needed.', bodyText: 'Your statement for the month is available.\n\nBalance: 4,210 gil\nPending: 0\n\nNo action needed.', minutesAgo: 240, read: true },
  { thread: 't-moogle', from: 'The Honourable Order of Seventeen Thousand Wandering Moogles and Associated Parties <order@moogles.example>', subject: 'An extremely long subject line about the annual gathering of the Order, including catering, seating, lanterns, and a request that nobody bring their own drum', snippet: 'Kupo! Details inside about where to sit, what to bring, and which drums are permitted.', bodyText: 'Kupo!\n\nDetails about where to sit, what to bring, and which drums are permitted are below. In short: no drums.', minutesAgo: 400, read: true },
  { thread: 't-sabin', from: 'Sabin Figaro <sabin@figaro.example>', subject: 'Training montage, next Tuesday?', snippet: 'Cliffs, waterfalls, push-ups. Bring a towel. Edgar says he will supervise from a chair.', bodyText: 'Cliffs, waterfalls, push-ups. Bring a towel.\n\nEdgar says he will supervise from a chair.', minutesAgo: 600, read: false },
  { thread: 't-sabin', from: ME, to: 'Sabin Figaro <sabin@figaro.example>', subject: 'Re: Training montage, next Tuesday?', snippet: 'Count me in. I will bring snacks for the supervisor too.', bodyText: 'Count me in. I will bring snacks for the supervisor too.', minutesAgo: 560, read: true },
  { thread: 't-celes', from: 'Celes Chere <celes@opera-house.example>', subject: 'Rehearsal schedule for the opera', snippet: 'Act two moves to Thursday because the stage flowers have not arrived.', bodyText: 'Act two moves to Thursday because the stage flowers have not arrived. Please let the orchestra know.', minutesAgo: 780, read: true },
  { thread: 't-toad', from: 'Paper Toad Post <hello@toadtown.example>', subject: 'Your parcel is folded and on its way', snippet: 'We folded your parcel into a tiny crane to save space. Unfold carefully.', bodyText: 'We folded your parcel into a tiny crane to save space. Unfold carefully, starting from the left wing.', minutesAgo: 900, read: false },
  { thread: 't-cid', from: 'Cid <cid@workshop.example>', subject: 'Airship maintenance notes', snippet: 'Propeller number three is making the noise again. I have a theory and a wrench.', bodyText: 'Propeller number three is making the noise again. I have a theory and a wrench.', minutesAgo: 1100, read: true },
  { thread: 't-library', from: 'Library of Zeal <desk@zeal-library.example>', subject: 'Overdue: "A Brief History of Tomorrow"', snippet: 'This book is now 400 years overdue. We are not angry, just disappointed.', bodyText: 'This book is now 400 years overdue. We are not angry, just disappointed.', minutesAgo: 1500, read: true },
  { thread: 't-tea', from: 'Tea Leaf Subscription <leaf@teabox.example>', subject: 'Your autumn blend ships tomorrow', snippet: 'Roasted chestnut, orange peel and a little cinnamon. Cozy in a cup.', bodyText: 'Roasted chestnut, orange peel and a little cinnamon. Cozy in a cup.', minutesAgo: 1700, read: true },
  { thread: 't-mog', from: 'Mog <mog@moogle.example>', subject: 'Kupo! Found your lost scarf', snippet: 'It was in the lost-and-found barrel. Only slightly chewed.', bodyText: 'It was in the lost-and-found barrel. Only slightly chewed. I can bring it Friday.', minutesAgo: 1900, read: false },
  { thread: 't-farm', from: 'Sunny Acres Farm <orders@sunnyacres.example>', subject: 'Pumpkins are in!', snippet: 'This week: pumpkins, apples, and one extremely proud goat.', bodyText: 'This week: pumpkins, apples, and one extremely proud goat.', minutesAgo: 2300, read: true },
  { thread: 't-book', from: 'Bookshop on Elm <hello@elmbooks.example>', subject: 'Your reading nook starter list', snippet: 'Five gentle stories for a rainy afternoon, hand picked by the staff.', bodyText: 'Five gentle stories for a rainy afternoon, hand picked by the staff.', minutesAgo: 2600, read: true },
  { thread: 't-music', from: 'Nobuo <nobuo@sounds.example>', subject: 'New track: "Memories of a Quiet Village"', snippet: 'A twelve-minute loop that never quite repeats. Best with headphones.', bodyText: 'A twelve-minute loop that never quite repeats. Best with headphones.', minutesAgo: 3000, read: true },
  { thread: 't-garden', from: 'Community Garden <plots@gardenclub.example>', subject: 'Plot 14 is yours', snippet: 'Sunny corner by the fence, with a very polite scarecrow.', bodyText: 'Sunny corner by the fence, with a very polite scarecrow. Seeds are in the shed.', minutesAgo: 3400, read: true },
  { thread: 't-maps', from: 'Cartographers Guild <maps@cartography.example>', subject: 'Updated map of the Northern Cave', snippet: 'We found two new passages and one old argument about the compass.', bodyText: 'We found two new passages and one old argument about the compass.', minutesAgo: 3900, read: true },
  { thread: 't-bakery', from: 'Moonrise Bakery <rolls@moonrise.example>', subject: 'Fresh cinnamon rolls, 6am tomorrow', snippet: 'Pre-order before midnight and we will keep a warm one for you.', bodyText: 'Pre-order before midnight and we will keep a warm one for you.', minutesAgo: 4300, read: true },
  { thread: 't-fishing', from: 'Fishing Club <pond@fishingclub.example>', subject: 'Saturday: the great pond tournament', snippet: 'Prizes for the biggest catch, the smallest catch, and the most dramatic loss.', bodyText: 'Prizes for the biggest catch, the smallest catch, and the most dramatic loss.', minutesAgo: 4800, read: true },
  { thread: 't-lamp', from: 'Lamplighter Union <lights@lamplighters.example>', subject: 'Evening shift swap request', snippet: 'Could you cover the east street lamps on Thursday? I will owe you a pie.', bodyText: 'Could you cover the east street lamps on Thursday? I will owe you a pie.', minutesAgo: 5200, read: true },
  { thread: 't-school', from: 'Village School <office@villageschool.example>', subject: 'Storytime this Friday', snippet: 'Bring a cushion. Today we hear about the dragon who was afraid of the dark.', bodyText: 'Bring a cushion. Today we hear about the dragon who was afraid of the dark.', minutesAgo: 5800, read: true },
  { thread: 't-post', from: 'Postmaster <post@villagepost.example>', subject: 'A letter has arrived for you', snippet: 'Handwritten, sealed with green wax, smelling faintly of woodsmoke.', bodyText: 'Handwritten, sealed with green wax, smelling faintly of woodsmoke. Collect it at the counter.', minutesAgo: 6400, read: true },
  { thread: 't-stars', from: 'Observatory Club <sky@stargazers.example>', subject: 'Meteor shower tonight', snippet: 'Best viewing from the hill behind the inn. Bring a blanket and cocoa.', bodyText: 'Best viewing from the hill behind the inn. Bring a blanket and cocoa.', minutesAgo: 7000, read: true },
  { thread: 't-welcome', from: 'VibeMail <welcome@vibemail.example>', subject: 'Welcome to VibeMail Cozy', snippet: 'Your mail now lives in a village inn. Pull up a chair.', bodyText: 'Your mail now lives in a village inn. Pull up a chair.', minutesAgo: 8000, read: true },
];

const NOW = Date.now();
let counter = 0;

function nextId(): string {
  counter += 1;
  return `mock-${String(counter).padStart(3, '0')}`;
}

function seedMessages(): Message[] {
  return SEEDS.map((s) => {
    const id = nextId();
    return {
      id,
      threadId: s.thread,
      subject: s.subject,
      from: s.from,
      to: s.to ?? ME,
      cc: s.cc ?? null,
      snippet: s.snippet,
      bodyText: s.bodyText,
      bodyHtml: s.bodyHtml ?? null,
      isRead: s.read,
      receivedAt: new Date(NOW - s.minutesAgo * 60_000).toISOString(),
    };
  });
}

let store: Message[] = seedMessages();

export function resetMockStore(): void {
  counter = 0;
  store = seedMessages();
}

interface MockFlags {
  fail: string | null;
  op: string | null;
  empty: boolean;
  slowMs: number;
}

function readFlags(): MockFlags {
  if (typeof window === 'undefined') return { fail: null, op: null, empty: false, slowMs: 0 };
  const params = new URLSearchParams(window.location.search);
  const slow = Number(params.get('mockSlow') ?? '0');
  return {
    fail: params.get('mockFail'),
    op: params.get('mockOp'),
    empty: params.get('mockEmpty') === '1',
    slowMs: Number.isFinite(slow) && slow > 0 ? Math.min(slow, 10_000) : 220,
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function failureFor(flags: MockFlags, op: string): Error | null {
  if (!flags.fail) return null;
  if (flags.op && flags.op !== op) return null;
  if (flags.fail === 'NETWORK') return new NetworkError();
  if (flags.fail === 'AUTH_FAILED') return new ApiError('AUTH_FAILED', 'Session expired', 401, true);
  if (flags.fail === 'AUTH_FAILED_FATAL') return new ApiError('AUTH_FAILED', 'Refresh token revoked', 401, false);
  const code = flags.fail as ApiErrorCode;
  const status: Record<ApiErrorCode, number> = {
    AUTH_FAILED: 401,
    INVALID_REQUEST: 400,
    NOT_FOUND: 404,
    RATE_LIMITED: 429,
    PROVIDER_ERROR: 502,
    INTERNAL_ERROR: 500,
  };
  return new ApiError(code, `Simulated ${code}`, status[code] ?? 500);
}

function encodeCursor(m: Message): string {
  return btoa(JSON.stringify({ receivedAt: m.receivedAt, id: m.id }));
}

function decodeCursor(cursor: string): { receivedAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).receivedAt === 'string' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      const p = parsed as { receivedAt: string; id: string };
      return { receivedAt: p.receivedAt, id: p.id };
    }
  } catch {
    // fall through
  }
  throw new ApiError('INVALID_REQUEST', 'Invalid cursor', 400);
}

export function createMockClient(): ApiClient {
  return {
    async listMessages(params: ListParams): Promise<MessagePage> {
      const flags = readFlags();
      await delay(flags.slowMs);
      const failure = failureFor(flags, 'list');
      if (failure) throw failure;

      const limit = params.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ApiError('INVALID_REQUEST', 'limit must be between 1 and 100', 400);
      }
      let rows = flags.empty ? [] : sortNewestFirst(store);
      if (params.unreadOnly) rows = rows.filter((m) => !m.isRead);
      if (params.cursor) {
        const after = decodeCursor(params.cursor);
        rows = rows.filter((m) => m.receivedAt < after.receivedAt || (m.receivedAt === after.receivedAt && m.id < after.id));
      }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        messages: page.map((m) => ({ ...m })),
        nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      };
    },

    async sendMessage(request: SendRequest): Promise<SendResponse> {
      const flags = readFlags();
      await delay(Math.max(flags.slowMs, 500));
      const failure = failureFor(flags, 'send');
      if (failure) throw failure;
      const id = nextId();
      const threadId = request.threadId ?? `t-sent-${id}`;
      store.push({
        id,
        threadId,
        subject: request.subject,
        from: ME,
        to: request.to.join(', '),
        cc: request.cc && request.cc.length > 0 ? request.cc.join(', ') : null,
        snippet: request.bodyText.slice(0, 120),
        bodyText: request.bodyText,
        bodyHtml: null,
        isRead: true,
        receivedAt: new Date().toISOString(),
      });
      return { id, threadId, status: 'sent' };
    },

    async setReadState(id: string, isRead: boolean): Promise<ReadResponse> {
      const flags = readFlags();
      await delay(Math.min(flags.slowMs, 400));
      const failure = failureFor(flags, 'read');
      if (failure) throw failure;
      const message = store.find((m) => m.id === id);
      if (!message) throw new ApiError('NOT_FOUND', 'Message not found', 404);
      message.isRead = isRead;
      return { id, isRead };
    },
  };
}
