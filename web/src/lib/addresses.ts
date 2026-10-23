export interface Sender {
  name: string;
  address: string;
}

/** Split an RFC 5322 `From`-style value ("Name <a@b.c>" or "a@b.c") into name and address. */
export function parseSender(from: string): Sender {
  const trimmed = from.trim();
  const match = /^(.*?)\s*<([^<>]+)>\s*$/.exec(trimmed);
  if (match) {
    const name = (match[1] ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
    const address = (match[2] ?? '').trim();
    return { name: name || address, address };
  }
  return { name: trimmed, address: trimmed };
}

export function senderInitials(from: string): string {
  const { name } = parseSender(from);
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

const ADDRESS_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** Light well-formedness check; the server is the authority (`INVALID_REQUEST`). */
export function isValidAddress(address: string): boolean {
  return ADDRESS_PATTERN.test(address.trim());
}

/** "Re: subject" without doubling an existing prefix. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed || '(no subject)'}`;
}

export function displaySubject(subject: string): string {
  return subject.trim() ? subject : '(no subject)';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Today: clock time. Within a week: weekday. Older: short date. */
export function formatReceived(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) {
    const h = date.getHours();
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  }
  if (days < 7) return WEEKDAYS[date.getDay()] ?? '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${sameYear ? '' : `, ${date.getFullYear()}`}`;
}

export function formatFull(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} · ${formatReceived(iso, date)}`;
}
