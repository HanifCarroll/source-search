import {sourceKind,type SourceCatalog} from './source-catalog';
import type { Query } from './contracts';

export function isProjected(source: string, catalog:SourceCatalog={}) {
  return ["tasks","gmail","fastmail","jmap","imap","muesli","whatsapp","messages","things-archive","chatgpt-archive","takeout-archive","linkedin-archive","twitter-archive","documents"].includes(sourceKind(source,catalog));
}
export function usesLibrary(q: Pick<Query, 'source' | 'mode'>, catalog:SourceCatalog={}) {
  return q.source === 'library' || q.source === 'documents' ||
    isProjected(q.source,catalog) && !!q.mode && q.mode !== 'lexical';
}
export function contextMode(source: Query['source'],catalog:SourceCatalog={}): 'none' | 'neighbors' | 'inline' {
  source=sourceKind(source,catalog);
  if (source === 'agent-history') return 'inline';
  return ['gmail', 'fastmail', 'jmap', 'imap', 'messages',
    'whatsapp', 'chatgpt-archive', 'linkedin-archive', 'twitter-archive'].includes(source)
    ? 'neighbors' : 'none';
}
export function canTrimItems(q: Query,catalog:SourceCatalog={}) {
  // Library cursors belong to derived hits even when the requested source is mail.
  return usesLibrary(q,catalog) || !['gmail', 'agent-history'].includes(sourceKind(q.source,catalog));
}
