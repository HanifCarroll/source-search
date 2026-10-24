import {basename} from 'node:path';
import {createSnapshot} from '../../platform/sqlite';
import {contained} from '../../platform/source-files';
import {readPlist} from '../../platform/plist';
import {sourceScope,type Config} from '../../platform/config';
import {scanRecords} from '../../domain/scan';
import {recordPage} from '../../domain/pages';
import {assertVersion,cursor,fail,hash,now,position,queryKey,versioned} from '../../domain/identity';
import type {Query,Ref,RecordData,Page} from '../../domain/contracts';
import {stores,firefoxBookmarks,safariBookmarks,type Browser,type BrowserRow} from './stores';

function settings(c:Config,source:string){
  const s=c.sources[source];
  if(!s||!['firefox-history','firefox-bookmarks','safari-history','safari-bookmarks'].includes(s.adapter)||!('profiles' in s)||!s.profiles?.length)fail('SOURCE_NOT_CONFIGURED','Configure browser profiles with stable IDs and absolute folder paths');
  return {browser:s.adapter.split('-')[0] as Browser,bookmarks:s.adapter.endsWith('bookmarks'),profiles:s.profiles};
}
function record(c:Config,source:string,browser:Browser,bookmarks:boolean,profile:{id:string;path:string},row:BrowserRow):RecordData{
  const time=row.time===undefined?NaN:stores[browser].milliseconds(Number(row.time));
  const title=row.title||row.url, id=Buffer.from(JSON.stringify([profile.id,String(row.id)])).toString('base64url');
  const result=versioned({adapter:browser+(bookmarks?'-bookmarks':'-history'),ref:{source,id},title,
    body:[title,row.url,row.folder&&`Folder: ${row.folder}`].filter(Boolean).join('\n'),
    type:bookmarks?'browser-bookmark':'browser-history',locator:row.url,observedAt:now(),
    ...(Number.isFinite(time)&&Math.abs(time)<8640000000000000?{occurredAt:new Date(time).toISOString()}:{}),
    metadata:{browser,profile:profile.id,profileName:basename(profile.path),url:row.url,...(row.folder?{folder:row.folder}:{})}});
  result.ref.version=hash(result.ref.version+sourceScope(c,source));return result;
}
async function bookmarks(c:Config,source:string){
  const s=settings(c,source),records:RecordData[]=[];
  for(const profile of s.profiles){
    let rows:BrowserRow[];
    if(s.browser==='safari')rows=safariBookmarks(await readPlist(await contained(profile.path,'Bookmarks.plist')));
    else{const snap=await createSnapshot(await contained(profile.path,stores.firefox.file));try{rows=firefoxBookmarks(snap.database);}finally{await snap.close();}}
    records.push(...rows.map(row=>record(c,source,s.browser,true,profile,row)));
    if(records.length>100000)fail('SOURCE_LIMIT','Selected bookmarks exceed 100,000 records');
  }
  return records;
}
export async function browserStatus(c:Config,source:string){
  const s=settings(c,source);
  let count:number|undefined;
  if(s.bookmarks)count=(await bookmarks(c,source)).length;
  else for(const profile of s.profiles){const snap=await createSnapshot(await contained(profile.path,stores[s.browser].file));try{stores[s.browser].check(snap.database);}finally{await snap.close();}}
  return {available:true,records:count,profiles:s.profiles.map(p=>p.id),filters:s.browser==='safari'&&s.bookmarks?[]:['from','to'],
    coverage:'Selected browser profiles and locally retained '+(s.bookmarks?'bookmarks':'visits')+'; page contents are not downloaded',warnings:[]};
}
export async function searchBrowser(c:Config,q:Query):Promise<Page>{
  const s=settings(c,q.source);
  if(q.conversation)fail('UNSUPPORTED_FILTER','Browser metadata has no conversation filter');
  if(s.bookmarks){if(s.browser==='safari'&&(q.from||q.to))fail('UNSUPPORTED_FILTER','Safari bookmarks have no creation timestamp');return recordPage(await bookmarks(c,q.source),q);}
  const key=queryKey(q)+sourceScope(c,q.source),raw=position(q.cursor,key);let state:{profile:number;cursor?:string}={profile:0};
  if(raw!==undefined){try{state=JSON.parse(String(raw));if(!Number.isInteger(state.profile)||state.profile<0||state.profile>=s.profiles.length||state.cursor!==undefined&&typeof state.cursor!=='string')throw Error();}catch{fail('INVALID_CURSOR','Invalid browser profile continuation');}}
  const profile=s.profiles[state.profile]!,store=stores[s.browser],snap=await createSnapshot(await contained(profile.path,store.file));
  try{
    store.check(snap.database);
    const page=scanRecords(snap.database,store.select,[],[],store.time,store.id,{...q,cursor:state.cursor},row=>record(c,q.source,s.browser,false,profile,row));
    for(const hit of page.items)hit.cursorAfter=cursor(key,JSON.stringify({profile:state.profile,cursor:hit.cursorAfter}));
    if(page.nextCursor)page.nextCursor=cursor(key,JSON.stringify({profile:state.profile,cursor:page.nextCursor}));
    else if(state.profile+1<s.profiles.length)page.nextCursor=cursor(key,JSON.stringify({profile:state.profile+1}));
    page.sourceWarnings=['Only selected profiles and locally retained visits; ordering is per profile.'];return page;
  }finally{await snap.close();}
}
export async function readBrowser(c:Config,ref:Ref){
  const s=settings(c,ref.source);let id:string[];
  try{id=JSON.parse(Buffer.from(ref.id,'base64url').toString());if(!Array.isArray(id)||id.length!==2||id.some(v=>typeof v!=='string'))throw Error();}catch{return fail('INVALID_REFERENCE','Invalid browser reference');}
  const profile=s.profiles.find(p=>p.id===id[0]);if(!profile)fail('STALE_RECORD','Browser profile is no longer selected');
  let found:RecordData|undefined;
  if(s.bookmarks)found=(await bookmarks(c,ref.source)).find(r=>r.ref.id===ref.id);
  else{
    if(!/^\d+$/.test(id[1]!))fail('INVALID_REFERENCE','Invalid browser visit ID');
    const store=stores[s.browser],snap=await createSnapshot(await contained(profile.path,store.file));
    try{store.check(snap.database);const row=snap.database.query(store.select+` WHERE ${store.id}=?`).get(id[1]!) as BrowserRow|null;if(row)found=record(c,ref.source,s.browser,false,profile,row);}finally{await snap.close();}
  }
  if(!found)fail('RECORD_NOT_FOUND','Browser record is no longer in the selected profile');assertVersion(ref,found.ref.version!);return found;
}
