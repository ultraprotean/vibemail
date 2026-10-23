import type { ReactNode } from 'react';

/** Wrap case-insensitive matches of `query` in <mark>. An empty query renders plain text. */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let key = 0;
  for (;;) {
    const at = lower.indexOf(target, from);
    if (at === -1) break;
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={key++}>{text.slice(at, at + target.length)}</mark>);
    from = at + target.length;
  }
  if (parts.length === 0) return text;
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}
