import {join} from 'node:path';
import {hash,fail,stableJson} from '../../domain/identity';
import {databasePath,markdownSettings,sourceConfig,sourceEnabled,sourceScope} from '../../platform/config';
import {sourceKind} from '../../domain/source-catalog';
import {sourceFiles,matchesNote,readNote} from '../../sources/local/notes';
import {isDailyJournal,journalRecord} from '../../sources/local/journals';
import {allMessageRecords} from '../../sources/messages';
import {allDatabaseRecords,databaseProjectionVersion} from '../../sources/local/databases';
import {allChromeRecords} from '../../sources/local/chrome';
import {allBrowserRecords} from '../../sources/browser';
import {stores} from '../../sources/browser/stores';
import {nativePimRecords} from '../../sources/local/pim';
import {filePimRecords} from '../../sources/local/pim-files';
import {observed,state,stamp,stamped,stableRead,type Reader} from './model';
import type {RecordData} from '../../domain/contracts';

export const markdown:Reader=async(c,source,previous)=>{
 const s=markdownSettings(c,source),listing=await sourceFiles(s.root,name=>matchesNote(c,source,name),s.exclude);
 // Links are deliberately excluded by the direct reader too; unreadable files
 // throw instead of pretending that the old record was removed.
 const old=new Map(previous?.entries.map(e=>[e.ref.id,e])),entries=[];
 for(const id of listing.paths){
  const path=join(s.root,id),input=await stamp([path]),saved=old.get(id);
  if(saved?.input===input){entries.push(saved);continue;}
  const read=await stableRead(path,()=> (isDailyJournal(c,source)?journalRecord:readNote)(c,{source,id}));
  entries.push({...observed(read.value),input:read.input});
 }
 if(JSON.stringify(listing.paths)!==JSON.stringify((await sourceFiles(s.root,name=>matchesNote(c,source,name),s.exclude)).paths))fail('SOURCE_CHANGED','Note selection changed during scan; retry synchronization');
 return {entries,state:state('file-fingerprints','Selected Markdown files; symbolic links are excluded')};
};
export const native:Reader=async(c,source,previous)=>{
 const kind=sourceKind(source,c),scoped=sourceConfig(c,source),path=kind==='messages'?scoped.messages:databasePath(c,source);
 const version=kind==='messages'?1:databaseProjectionVersion(source,c),generation=String(version);
 const retainRecords=c.libraryEnabled&&sourceEnabled(c,'library');
 const paths=[path,path+'-wal'],scope=sourceScope(c,source);
 const old=new Map(previous?.state.generation===generation?previous.entries.map(e=>[e.key,e]):[]);
 const needsRecords=retainRecords&&(!previous?.state.projection||previous.entries.some(e=>!e.record));
 // Enabling library publication fills the body cache once without resetting
 // existing change cursors or changing record versions.
 const reusable=needsRecords?undefined:previous;
 let decoded=0,reused=0;
 const scan=await stamped(paths,reusable,{...state('snapshot-row-fingerprints','Current local database, including records without searchable text; phone-only history is outside coverage'),generation},async()=>{
  const reuse=(key:string,raw:unknown,project:()=>RecordData)=>{
   const input=hash(JSON.stringify(raw,(_k,v)=>typeof v==='bigint'?String(v):v instanceof Uint8Array?Buffer.from(v).toString('base64'):v)),saved=old.get(key);
   if(saved?.input===input&&(!retainRecords||saved.record)){reused++;return saved;}
   decoded++;
   const record=project();
   return {...observed(record,source),signature:hash(stableJson({...record,observedAt:undefined})),key,input,
    ...(retainRecords?{record:{...record,...(source!==kind?{adapter:kind}:{}),ref:{...record.ref,source}}}:{})};
  };
  return kind==='messages'?allMessageRecords(scoped,reuse):allDatabaseRecords(c,source,reuse);
 },true);
 if(retainRecords){
  const entries=scan.entries;
  const revision=entries?hash(stableJson(entries.map(e=>[e.ref.id,e.signature]).sort((a,b)=>a[0]!.localeCompare(b[0]!)))):previous!.state.projection!.revision;
  const keys=new Set(entries?.map(e=>e.key));
  scan.state.projection={kind:'native',revision,scope,version,guard:{paths},incremental:{decoded,reused,removed:entries?[...old.keys()].filter(k=>!keys.has(k)).length:0}};
 }
 return scan;
};
export const browser:Reader=async(c,source,previous)=>{
 const kind=sourceKind(source,c),scoped=sourceConfig(c,source),chromium=kind.startsWith('chrome-'),bookmarks=kind.endsWith('bookmarks');
 const definition=c.sources[source];
 const profiles=chromium?scoped.chromeProfiles:definition&&'profiles' in definition?definition.profiles?.map(p=>p.path)||[]:[];
 const file=chromium?(bookmarks?'Bookmarks':'History'):kind.startsWith('safari-')?(bookmarks?'Bookmarks.plist':stores.safari.file):stores.firefox.file;
 const paths=profiles.flatMap(p=>[join(p,file),...(!bookmarks||kind.startsWith('firefox-')?[join(p,file)+'-wal']:[])]);
 return stamped(paths,previous,state('browser-inventory-diff','All retained records in selected profiles; history expiry/removal appears as removed'),async()=>
  (await (chromium?allChromeRecords(scoped,kind):allBrowserRecords(c,source))).map(r=>observed(r,source)),true);
};
export const pim:Reader=async(c,source)=>{
 const kind=sourceKind(source,c),calendar=kind==='calendar'||kind==='ical';
 // Fix the window for a calendar month. Moving it emits one explicit reset,
 // rather than inventing deletions for occurrences that aged out.
 const anchor=new Date();anchor.setUTCDate(1);anchor.setUTCHours(0,0,0,0);
 const range=calendar?{from:new Date(+anchor-c.changeTracking.calendarPastDays*86400000).toISOString(),to:new Date(+anchor+c.changeTracking.calendarFutureDays*86400000).toISOString()}:undefined;
 const result=kind==='ical'||kind==='vcard'?await filePimRecords(c,source,range):await nativePimRecords(sourceConfig(c,source),kind as 'calendar'|'contacts',range);
 if(result.warnings.length)fail('INCOMPLETE_SCAN',result.warnings.join('; '));
 return {entries:result.records.map(r=>observed(r,source)),state:{...state('complete-inventory-diff',range?`Calendar occurrences from ${range.from} to ${range.to}; window advances monthly`:'All selected contacts'),...(range?{generation:JSON.stringify(range),checkpoint:range}:{})}};
};
