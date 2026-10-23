import type { Query } from './contracts';

// Sources whose records can be projected into the cross-source library.
export const librarySources = [
  'things-archive', 'chatgpt-archive', 'takeout-archive', 'linkedin-archive',
  'twitter-archive', 'messages', 'whatsapp', 'calls', 'mail-personal',
  'mail-consulting', 'mail-fastmail', 'documents',
] as const;
export function isProjected(source: string) {
  return (librarySources as readonly string[]).includes(source);
}
export function usesLibrary(q: Pick<Query, 'source' | 'mode'>) {
  return q.source === 'library' || q.source === 'documents' ||
    isProjected(q.source) && !!q.mode && q.mode !== 'lexical';
}
export function contextMode(source: Query['source']): 'none' | 'neighbors' | 'inline' {
  if (source === 'agent-history') return 'inline';
  return ['mail-personal', 'mail-consulting', 'mail-fastmail', 'messages',
    'whatsapp', 'chatgpt-archive', 'linkedin-archive', 'twitter-archive'].includes(source)
    ? 'neighbors' : 'none';
}
export function canTrimItems(q: Query) {
  // Library cursors belong to derived hits even when the requested source is mail.
  return usesLibrary(q) || !['mail-personal', 'mail-consulting', 'agent-history'].includes(q.source);
}
