import {sourceDefinition,type SourceCatalog} from './source-catalog';
import type {Query} from './contracts';
export function isProjected(source:string,catalog:SourceCatalog={}) {
  return sourceDefinition(source,catalog)?.projected || false;
}
export function usesLibrary(q:Pick<Query,'source'|'mode'>,catalog:SourceCatalog={}) {
  return sourceDefinition(q.source,catalog)?.family==='library' ||
    isProjected(q.source,catalog) && !!q.mode && q.mode!=='lexical';
}
export function contextMode(source:string,catalog:SourceCatalog={}) {
  return sourceDefinition(source,catalog)?.context || 'none';
}
export function canTrimItems(q:Query,catalog:SourceCatalog={}) {
  return usesLibrary(q,catalog) || sourceDefinition(q.source,catalog)?.trimItems!==false;
}
