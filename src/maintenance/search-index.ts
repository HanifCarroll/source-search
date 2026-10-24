import {configuredSourceIds,requireMaintenance,requireSource,sourceConfig,type Config} from '../platform/config';
import {sourceKind} from '../domain/source-catalog';
import {runSdk} from '../search/qmd/runner';
import {fail} from '../domain/identity';
import {syncLibrary} from './library-sync';

export async function indexSources(c:Config,args:string[]) {
 requireMaintenance(c);
 const sourceFlag=args.indexOf('--source'),selected=sourceFlag>=0?args[sourceFlag+1]:undefined;
 if(sourceFlag>=0&&!selected)fail('INVALID_QUERY','--source requires a source ID');
 const ids=args.includes('--library')?['library']:selected?[selected]:configuredSourceIds(c).filter(id=>c.enabledSources.includes(id)&&sourceKind(id,c)==='vault');
 if(!ids.length)fail('SOURCE_NOT_CONFIGURED','Enable a vault source, or use --library for projected sources.');
 const results=[];
 for(const id of ids){
  requireSource(c,id);const kind=sourceKind(id,c);if(kind!=='vault'&&kind!=='library')fail('UNSUPPORTED_SOURCE','Use rebuild for archive indexes; index accepts vault or library sources.');
  const scoped=sourceConfig(c,id),result:Record<string,unknown>={source:id};
  if(kind==='library'&&!c.libraryEnabled)fail('SOURCE_NOT_CONFIGURED','Set libraryEnabled to true before indexing the library.');
  if(!args.includes('--embed-only')){
   if(kind==='library'&&!args.includes('--update-only'))await syncLibrary(c,{refreshSources:!args.includes('--skip-source-sync')});
   result.update=await runSdk(scoped,{index:kind,action:'update'});
   if((result.update as {skipped:number}).skipped)fail('SOURCE_PARTIAL','Some source files could not be indexed; make them available and rerun index.');
  }
  if(args.includes('--embed')||args.includes('--embed-only'))result.embed=await runSdk(scoped,{index:kind,action:'embed'});
  results.push(result);
 }
 return results;
}
