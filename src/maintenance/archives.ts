import {sourceConfig,configuredSourceIds,sourceEnabled,type Config} from '../platform/config';
import {sourceKind} from '../domain/source-catalog';
import {archiveSources,type ArchiveSource} from '../sources/archives/originals';
import {rebuildArchive} from '../sources/archives/index';
export const archiveInstances=(c:Config)=>configuredSourceIds(c).filter(id=>sourceEnabled(c,id)&&archiveSources.includes(sourceKind(id,c) as ArchiveSource));
export function archiveConfig(c:Config,id:string){const kind=sourceKind(id,c);return {...sourceConfig(c,id),enabledSources:[kind],sources:c.sources[id]?{[kind]:c.sources[id]!}:{}};}
export async function rebuildConfiguredArchives(c:Config){
 const results=[await rebuildArchive(c)];
 for(const id of archiveInstances(c).filter(id=>id!==sourceKind(id,c)))results.push(await rebuildArchive(archiveConfig(c,id)));
 return {indexes:results,indexedRecords:results.reduce((n,r)=>n+r.indexedRecords,0)};
}
