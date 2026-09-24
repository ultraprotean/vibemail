import {
  buildRfc2822Message,
  encodeHeaderText,
  encodeRawMessage,
  isValidAddress,
  SendValidationError,
} from '../../src/send/mime';

/** Split a message into its header block (unfolded map) and body. */
function parse(message: string): { headers: Map<string, string>; body: string } {
  const split = message.indexOf('\r\n\r\n');
  const headers = new Map<string, string>();
  for (const line of message.slice(0, split).split('\r\n')) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body: message.slice(split + 4) };
}

const decodeBase64Body = (body: string): string => Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');

describe('buildRfc2822Message', () => {
  it('builds a plain-text message with CRLF line endings and no From header', () => {
    const message = buildRfc2822Message({ to: ['bob@example.com'], subject: 'Hello', bodyText: 'Hi Bob' });
    const { headers, body } = parse(message);

    expect(message).not.toMatch(/[^\r]\n/);
    expect(headers.get('to')).toBe('bob@example.com');
    expect(headers.get('subject')).toBe('Hello');
    expect(headers.get('mime-version')).toBe('1.0');
    expect(headers.get('content-type')).toBe('text/plain; charset="UTF-8"');
    expect(headers.get('content-transfer-encoding')).toBe('base64');
    expect(headers.has('from')).toBe(false);
    expect(decodeBase64Body(body)).toBe('Hi Bob');
  });

  it('joins multiple recipients and includes Cc and Bcc', () => {
    const { headers } = parse(
      buildRfc2822Message({
        to: ['a@example.com', 'Bee <b@example.com>'],
        cc: ['c@example.com'],
        bcc: ['d@example.com'],
        subject: 'Team',
        bodyText: 'x',
      }),
    );
    expect(headers.get('to')).toBe('a@example.com, Bee <b@example.com>');
    expect(headers.get('cc')).toBe('c@example.com');
    expect(headers.get('bcc')).toBe('d@example.com');
  });

  it('builds multipart/alternative when both text and HTML are given', () => {
    const message = buildRfc2822Message(
      { to: ['a@example.com'], subject: 'Both', bodyText: 'plain', bodyHtml: '<b>html</b>' },
      'BOUNDARY',
    );
    const { headers, body } = parse(message);
    expect(headers.get('content-type')).toBe('multipart/alternative; boundary="BOUNDARY"');

    const parts = body.split('--BOUNDARY').map((p) => p.trim());
    expect(parts[parts.length - 1]).toBe('--');
    const [plain, html] = parts.slice(1, 3).map((p) => parse(p));
    expect(plain.headers.get('content-type')).toBe('text/plain; charset="UTF-8"');
    expect(decodeBase64Body(plain.body)).toBe('plain');
    expect(html.headers.get('content-type')).toBe('text/html; charset="UTF-8"');
    expect(decodeBase64Body(html.body)).toBe('<b>html</b>');
  });

  it('sends HTML-only bodies as text/html', () => {
    const { headers, body } = parse(buildRfc2822Message({ to: ['a@example.com'], subject: 'H', bodyHtml: '<p>x</p>' }));
    expect(headers.get('content-type')).toBe('text/html; charset="UTF-8"');
    expect(decodeBase64Body(body)).toBe('<p>x</p>');
  });

  it('adds In-Reply-To and References for replies', () => {
    const { headers } = parse(
      buildRfc2822Message({
        to: ['a@example.com'],
        subject: 'Re: Hello',
        bodyText: 'x',
        threadId: 't1',
        inReplyTo: '<abc@mail.gmail.com>',
      }),
    );
    expect(headers.get('in-reply-to')).toBe('<abc@mail.gmail.com>');
    expect(headers.get('references')).toBe('<abc@mail.gmail.com>');
  });

  it('encodes a non-ASCII subject as an RFC 2047 encoded-word', () => {
    const { headers } = parse(buildRfc2822Message({ to: ['a@example.com'], subject: 'Café ☕', bodyText: 'x' }));
    expect(headers.get('subject')).toBe(encodeHeaderText('Café ☕'));
    expect(headers.get('subject')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  });

  it('round-trips long, non-ASCII bodies with 76-character base64 lines', () => {
    const text = 'Ünïcödé ✓ '.repeat(40);
    const { body } = parse(buildRfc2822Message({ to: ['a@example.com'], subject: 'S', bodyText: text }));
    for (const line of body.trim().split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(decodeBase64Body(body)).toBe(text);
  });

  it.each([
    ['a subject', { to: ['a@example.com'], subject: 'Hi\r\nBcc: evil@example.com', bodyText: 'x' }],
    ['an address', { to: ['a@example.com\r\nBcc: evil@example.com'], subject: 'Hi', bodyText: 'x' }],
    ['inReplyTo', { to: ['a@example.com'], subject: 'Hi', bodyText: 'x', inReplyTo: '<a>\nBcc: evil@example.com' }],
  ])('rejects line breaks in %s (header injection)', (_label, input) => {
    expect(() => buildRfc2822Message(input)).toThrow(SendValidationError);
  });

  it.each([
    ['no recipients', { to: [], subject: 'S', bodyText: 'x' }],
    ['a blank subject', { to: ['a@example.com'], subject: '  ', bodyText: 'x' }],
    ['no body', { to: ['a@example.com'], subject: 'S', bodyText: '' }],
    ['a malformed address', { to: ['not-an-address'], subject: 'S', bodyText: 'x' }],
  ])('rejects %s', (_label, input) => {
    expect(() => buildRfc2822Message(input)).toThrow(SendValidationError);
  });
});

describe('isValidAddress', () => {
  it.each(['a@example.com', 'first.last+tag@sub.example.co.uk', 'Jane Doe <jane@example.com>', '"Doe, Jane" <j@example.com>'])(
    'accepts %s',
    (address) => expect(isValidAddress(address)).toBe(true),
  );

  it.each(['', 'plain', 'a@b', '@example.com', 'a@@example.com', 'a b@example.com', 'x <not-an-address>'])(
    'rejects %s',
    (address) => expect(isValidAddress(address)).toBe(false),
  );
});

describe('encodeRawMessage', () => {
  it('produces base64url without padding or +/ characters that decodes back', () => {
    const message = buildRfc2822Message({ to: ['a@example.com'], subject: '??>>', bodyText: '?>?>~~~' });
    const raw = encodeRawMessage(message);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toBe(message);
  });
});
