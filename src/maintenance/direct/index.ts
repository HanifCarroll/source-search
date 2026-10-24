import {join} from 'node:path';
import type {Config} from '../../platform/config';
import {evidenceScope,requireSource,requireMaintenance} from '../../platform/config';
import {sourceKind,isMail} from '../../domain/source-catalog';
import {errorData,fail,now} from '../../domain/identity';
import {recordStore} from '../../platform/record-store';
import {withSourceLock} from '../source-lock';
import {markdown,native,browser,pim} from './local';
import {archive,vault,agentHistory} from './indexes';
import {mail} from './mail';
import type {Reader} from './model';

export function directReader(c:Config,source:string):Reader{
 const kind=sourceKind(source,c);
 if(isMail(source,c))return mail;
 if(kind==='markdown')return markdown;
 if(['messages','whatsapp','muesli'].includes(kind))return native;
 if(/^(chrome|firefox|safari)-/.test(kind))return browser;
 if(['calendar','contacts','ical','vcard'].includes(kind))return pim;
 if(kind.endsWith('-archive'))return archive;
 if(kind==='vault')return vault;
 if(kind==='agent-history')return agentHistory;
 return fail('INVALID_SOURCE','This source has no direct change tracker');
}
export async function syncDirect(c:Config,sources:string[],reader=directReader){
 requireMaintenance(c);
 const store=recordStore(join(c.libraryRoot,'records.sqlite')),results=[];
 for(const source of sources){
  requireSource(c,source);const scope=evidenceScope(c,source);
  try{results.push(await withSourceLock(c,'direct-'+source,async assertOwned=>{
   const previous=await store.observation(source,scope),scan=await reader(c,source)(c,source,previous);
   if((scan.entries?.length||0)>500000)fail('SOURCE_LIMIT','Direct inventory exceeds 500,000 records; select fewer records');
   assertOwned();
   const result=await store.observe(source,scope,scan.entries,scan.state);
   return {source,ok:true,...result,strategy:scan.state.strategy,error:undefined};
  }));}catch(e){
   const error=errorData(e);results.push({source,ok:false,error});
   // A contending worker owns its status; do not overwrite a successful scan.
   if(error.code!=='ELOCKED')await store.observationFailure(source,scope,error,now());
  }
 }
 return {ok:results.every(r=>r.ok),sources:results};
}
