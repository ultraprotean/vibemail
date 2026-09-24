import { randomBytes } from 'node:crypto';
import type { SendMessageInput } from '../types/provider';

/**
 * RFC 2822 / MIME message construction for sending (CONTRACT.md §6.4).
 *
 * Provider-agnostic: produces a standard message. Bodies are always base64
 * transfer-encoded, so arbitrary text and HTML survive intact.
 */

const CRLF = '\r\n';

/** Input the caller must fix. Maps to 400 `INVALID_REQUEST`. */
export class SendValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendValidationError';
  }
}

/** A header value must not contain CR or LF, or it could inject extra headers. */
function assertSingleLine(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new SendValidationError(`${field} must not contain line breaks`);
  }
}

/**
 * Accepts `user@example.com` or `Name <user@example.com>`. Deliberately permissive about
 * the local part; strict enough to reject obvious garbage.
 */
export function isValidAddress(address: string): boolean {
  const angle = /<([^<>]+)>\s*$/.exec(address);
  const spec = (angle ? angle[1] : address).trim();
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(spec);
}

function addressList(field: string, addresses: string[]): string {
  for (const address of addresses) {
    assertSingleLine(field, address);
    if (!isValidAddress(address)) {
      throw new SendValidationError(`${field} contains an invalid address: ${address}`);
    }
  }
  return addresses.join(', ');
}

/** RFC 2047 encoded-word for non-ASCII header text (e.g. a subject with accents or emoji). */
export function encodeHeaderText(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Base64 with 76-character lines, as MIME requires. */
function base64Lines(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, (line) => `${line}${CRLF}`).trimEnd();
}

function bodyPart(contentType: string, text: string): string {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
  ].join(CRLF);
}

/**
 * Build the RFC 2822 message text. `From` is omitted: the sending provider fills in the
 * authenticated account's address. `Bcc` is included so the provider delivers to those
 * recipients; it strips the header from delivered copies.
 * @throws SendValidationError on missing fields, bad addresses, or header injection.
 */
export function buildRfc2822Message(input: SendMessageInput, boundary?: string): string {
  if (input.to.length === 0) throw new SendValidationError('to must contain at least one address');
  if (!input.subject.trim()) throw new SendValidationError('subject is required');
  if (!input.bodyText && !input.bodyHtml) throw new SendValidationError('bodyText or bodyHtml is required');
  assertSingleLine('subject', input.subject);

  const headers = [`To: ${addressList('to', input.to)}`];
  if (input.cc && input.cc.length > 0) headers.push(`Cc: ${addressList('cc', input.cc)}`);
  if (input.bcc && input.bcc.length > 0) headers.push(`Bcc: ${addressList('bcc', input.bcc)}`);
  headers.push(`Subject: ${encodeHeaderText(input.subject)}`);
  if (input.inReplyTo) {
    assertSingleLine('inReplyTo', input.inReplyTo);
    // Both headers are needed for the recipient's client (and Gmail) to thread the reply.
    headers.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`);
  }
  headers.push('MIME-Version: 1.0');

  if (input.bodyText && input.bodyHtml) {
    const sep = boundary ?? `vibemail-${randomBytes(12).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${sep}"`);
    return [
      headers.join(CRLF),
      '',
      `--${sep}`,
      bodyPart('text/plain', input.bodyText),
      `--${sep}`,
      bodyPart('text/html', input.bodyHtml),
      `--${sep}--`,
      '',
    ].join(CRLF);
  }

  const [type, text] = input.bodyHtml ? ['text/html', input.bodyHtml] : ['text/plain', input.bodyText ?? ''];
  return [headers.join(CRLF), bodyPart(type, text), ''].join(CRLF);
}

/** The whole message as base64url (no padding), the form `messages.send` takes in `raw`. */
export function encodeRawMessage(message: string): string {
  return Buffer.from(message, 'utf8').toString('base64url');
}
