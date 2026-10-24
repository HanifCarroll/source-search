import {requireSource,sourceScope,type Config} from '../platform/config';
import {sourceToken} from '../platform/source-auth';
import {providerHttp} from '../platform/http';
import {scopedProvider,snapshotStore} from './sync/cache';
import {googleCalendarProvider,googleContactsProvider} from './pim/google';
import {microsoftCalendarProvider,microsoftContactsProvider} from './pim/microsoft';
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
  const bind=(p:SourceProvider)=>scopedProvider(p,sourceScope(c,source));
  if(s?.adapter==='notes')return bind(notionProvider(source,s.connector,providerHttp('https://api.notion.com/v1',{token:s.connector.token,minIntervalMs:350,headers:{'Notion-Version':'2026-03-11'}}).json));
  if(s?.adapter!=='calendars'&&s?.adapter!=='address-books')fail('SOURCE_NOT_CONFIGURED','Configure a connected source');
  const connector=s.connector;
  if(connector.type==='caldav'||connector.type==='carddav')return bind(davProvider(source,connector,s.adapter==='calendars'?s.window:{pastDays:730,futureDays:365}));
  if(connector.type==='google'){
    const http=providerHttp(s.adapter==='calendars'?'https://www.googleapis.com/calendar/v3':'https://people.googleapis.com/v1',{token:sourceToken(c,source)}).json;
    return bind(s.adapter==='calendars'?googleCalendarProvider(source,'collections' in connector?connector.collections:undefined,s.window,http):googleContactsProvider(source,http));
  }
  const http=providerHttp(graphOrigin,{token:sourceToken(c,source),headers:graphHeaders}).json;
  return bind(s.adapter==='calendars'?microsoftCalendarProvider(source,connector.collections,s.window,http):microsoftContactsProvider(source,connector.collections,http));
}
export async function connectedStatus(c:Config,source:string){const status=await snapshotStore(c,source).status();return {...status,filters:c.sources[source]?.adapter==='address-books'?['types']:status.filters};}
export async function searchConnected(c:Config,q:Query){
  if(c.sources[q.source]?.adapter==='address-books'&&(q.from||q.to||q.sort&&q.sort!=='relevance'))fail('UNSUPPORTED_FILTER','Contacts have no occurrence dates; use relevance ordering');
  if(q.conversation)fail('UNSUPPORTED_FILTER','This source has no conversation filter');
  return snapshotStore(c,q.source).search(q);
}
export const readConnected=(c:Config,ref:Ref)=>snapshotStore(c,ref.source).original(ref,connectedProvider(c,ref.source));
