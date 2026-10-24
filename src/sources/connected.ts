import {requireSource,sourceScope,type Config} from '../platform/config';
import {sourceToken} from '../platform/source-auth';
import {providerHttp} from '../platform/http';
import {scopedProvider,snapshotStore} from './sync/cache';
import {googleCalendarProvider,googleContactsProvider} from './pim/google';
import {microsoftCalendarProvider,microsoftContactsProvider} from './pim/microsoft';
import {slackProvider} from './chat/slack';
import {githubProvider} from './issues/github';
import {githubRepositoryProvider} from './repositories/github';
import {linearProvider} from './issues/linear';
import {fileProvider} from './files/model';
import {googleFiles} from './files/google';
import {microsoftFiles} from './files/microsoft';
import {notionProvider} from './notes/notion';
import {davProvider} from './pim/dav';
import {graphOrigin,graphHeaders} from './sync/graph';
import {fail} from '../domain/identity';
import type {SourceProvider} from './sync/model';
import type {Query,Ref} from '../domain/contracts';

// One factory registers provider modules. Runtime and maintenance only know the
// shared snapshot interface, regardless of the app behind a source category.
export function connectedProvider(c:Config,source:string):SourceProvider{
  requireSource(c,source);const s=c.sources[source];
  if(!s||!('sync' in s))fail('SOURCE_NOT_CONFIGURED','Configure a connected source');
  const bind=(p:SourceProvider)=>scopedProvider(p,sourceScope(c,source));
  // Repository reads enforce selection directly and versions bind each file's
  // account, repository and branch. Adding another repository preserves refs.
  if(s.adapter==='repositories')return githubRepositoryProvider(source,s,providerHttp(s.connector.apiUrl,{...s.sync,token:s.connector.token,headers:{'X-GitHub-Api-Version':'2026-03-10',Accept:'application/vnd.github+json','User-Agent':'Source-Search'},minIntervalMs:100}).page);
  if(s?.adapter==='chat')return bind(slackProvider(source,s.connector,providerHttp('https://slack.com/api',{...s.sync,token:s.connector.token,minIntervalMs:1200}).json));
  if(s?.adapter==='issues'){const v=s.connector;return bind(v.type==='github'?githubProvider(source,v.repositories,providerHttp(v.apiUrl,{...s.sync,token:v.token,headers:{'X-GitHub-Api-Version':'2026-03-10',Accept:'application/vnd.github+json','User-Agent':'Source-Search'},minIntervalMs:100}).page,v.apiUrl):linearProvider(source,v,providerHttp('https://api.linear.app',{...s.sync,token:v.token,tokenScheme:v.authMode==='api-key'?'raw':'bearer',minIntervalMs:100}).json));}
  if(s?.adapter==='files'){const http=providerHttp(s.connector.type==='google'?'https://www.googleapis.com/drive/v3':graphOrigin,{...s.sync,token:sourceToken(c,source)});return bind(fileProvider(source,s,s.connector.type==='google'?googleFiles(s,http.json,http.text):microsoftFiles(s,s.connector.driveId,http.json)));}
  if(s?.adapter==='notes')return bind(notionProvider(source,s.connector,providerHttp('https://api.notion.com/v1',{...s.sync,token:s.connector.token,minIntervalMs:350,headers:{'Notion-Version':'2026-03-11'}}).json));
  if(s?.adapter!=='calendars'&&s?.adapter!=='address-books')fail('SOURCE_NOT_CONFIGURED','Configure a connected source');
  const connector=s.connector;
  if(connector.type==='caldav'||connector.type==='carddav')return bind(davProvider(source,connector,s.adapter==='calendars'?s.window:{pastDays:730,futureDays:365},undefined,s.sync));
  if(connector.type==='google'){
    const http=providerHttp(s.adapter==='calendars'?'https://www.googleapis.com/calendar/v3':'https://people.googleapis.com/v1',{...s.sync,token:sourceToken(c,source)}).json;
    return bind(s.adapter==='calendars'?googleCalendarProvider(source,'collections' in connector?connector.collections:undefined,s.window,http):googleContactsProvider(source,http));
  }
  const http=providerHttp(graphOrigin,{...s.sync,token:sourceToken(c,source),headers:graphHeaders}).json;
  return bind(s.adapter==='calendars'?microsoftCalendarProvider(source,connector.collections,s.window,http):microsoftContactsProvider(source,connector.collections,http));
}
export async function connectedStatus(c:Config,source:string){const status=await snapshotStore(c,source).status();return {...status,filters:['address-books','repositories'].includes(c.sources[source]?.adapter||'')?['types']:['issues','chat'].includes(c.sources[source]?.adapter||'')?[...status.filters,'conversation']:status.filters};}
export async function searchConnected(c:Config,q:Query){
  if(c.sources[q.source]?.adapter==='address-books'&&(q.from||q.to||q.sort&&q.sort!=='relevance'))fail('UNSUPPORTED_FILTER','Contacts have no occurrence dates; use relevance ordering');
  if(c.sources[q.source]?.adapter==='repositories'&&(q.from||q.to||q.sort&&q.sort!=='relevance'))fail('UNSUPPORTED_FILTER','Repository files have no per-file commit dates; use relevance ordering');
  if(q.conversation&&!['issues','chat'].includes(c.sources[q.source]?.adapter||''))fail('UNSUPPORTED_FILTER','This source has no conversation filter');
  return snapshotStore(c,q.source).search({...q,sort:q.sort||(['address-books','repositories'].includes(c.sources[q.source]?.adapter||'')?'relevance':'newest')});
}
export const readConnected=(c:Config,ref:Ref)=>snapshotStore(c,ref.source).original(ref,connectedProvider(c,ref.source));
