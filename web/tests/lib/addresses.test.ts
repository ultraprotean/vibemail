import { describe, expect, it } from 'vitest';
import { displaySubject, formatReceived, isValidAddress, parseSender, replySubject, senderInitials } from '@/lib/addresses';

describe('parseSender', () => {
  it('splits a display name and address', () => {
    expect(parseSender('Marle <marle@truceinn.example>')).toEqual({ name: 'Marle', address: 'marle@truceinn.example' });
    expect(parseSender('"Chere, Celes" <celes@x.example>')).toEqual({ name: 'Chere, Celes', address: 'celes@x.example' });
  });
  it('handles a bare address and an empty value', () => {
    expect(parseSender('a@b.example')).toEqual({ name: 'a@b.example', address: 'a@b.example' });
    expect(parseSender('')).toEqual({ name: '', address: '' });
    expect(parseSender('<a@b.example>')).toEqual({ name: 'a@b.example', address: 'a@b.example' });
  });
});

describe('senderInitials', () => {
  it('uses first and last word', () => {
    expect(senderInitials('Lucca Ashtear <l@x.example>')).toBe('LA');
    expect(senderInitials('Cid <c@x.example>')).toBe('C');
    expect(senderInitials('')).toBe('?');
  });
});

describe('isValidAddress', () => {
  it('accepts normal addresses and rejects malformed ones', () => {
    expect(isValidAddress('a@b.example')).toBe(true);
    expect(isValidAddress('  a@b.example ')).toBe(true);
    expect(isValidAddress('a@b')).toBe(false);
    expect(isValidAddress('nope')).toBe(false);
    expect(isValidAddress('a b@c.example')).toBe(false);
    expect(isValidAddress('Name <a@b.example>')).toBe(false);
  });
});

describe('replySubject', () => {
  it('prefixes Re: once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(replySubject('')).toBe('Re: (no subject)');
  });
});

describe('displaySubject', () => {
  it('shows a placeholder for an empty subject', () => {
    expect(displaySubject('')).toBe('(no subject)');
    expect(displaySubject('  ')).toBe('(no subject)');
    expect(displaySubject('Hi')).toBe('Hi');
  });
});

describe('formatReceived', () => {
  const now = new Date(2026, 9, 22, 15, 0, 0);
  it('shows clock time for today', () => {
    expect(formatReceived(new Date(2026, 9, 22, 9, 5).toISOString(), now)).toBe('9:05 AM');
    expect(formatReceived(new Date(2026, 9, 22, 0, 30).toISOString(), now)).toBe('12:30 AM');
  });
  it('shows the weekday within a week and a date after that', () => {
    expect(formatReceived(new Date(2026, 9, 20, 9, 5).toISOString(), now)).toBe('Tue');
    expect(formatReceived(new Date(2026, 8, 1, 9, 5).toISOString(), now)).toBe('Sep 1');
    expect(formatReceived(new Date(2025, 11, 25, 9, 5).toISOString(), now)).toBe('Dec 25, 2025');
  });
  it('returns an empty string for an invalid date', () => {
    expect(formatReceived('not a date', now)).toBe('');
  });
});
