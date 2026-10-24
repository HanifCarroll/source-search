import type {Config} from './config';
import {fail} from '../domain/identity';
import {googleToken} from './google-auth';
import {microsoftToken} from './microsoft-auth';
import type {GoogleOAuth,MicrosoftOAuth,Secret} from './auth-settings';

export function sourceAuthorization(c:Config,source:string):{kind:'google';oauth?:GoogleOAuth;token?:Secret;scopes:string[]}|{kind:'microsoft';oauth?:MicrosoftOAuth;token?:Secret;scopes:string[]}{
  const setting=c.sources[source];if(!setting||!('connector' in setting))fail('INVALID_CONFIG','Configure an OAuth-capable source first');
  const connector=setting.connector;
  if(connector.type==='google'||connector.type==='google-tasks'){
    const permission=connector.type==='google-tasks'?'tasks.readonly':setting.adapter==='calendars'?'calendar.readonly':setting.adapter==='files'?(setting.content==='text'?'drive.readonly':'drive.metadata.readonly'):'contacts.readonly';
    return {kind:'google',oauth:connector.oauth,token:connector.token,scopes:['https://www.googleapis.com/auth/'+permission]};
  }
  if(connector.type==='microsoft'||connector.type==='microsoft-todo'){
    const permission=connector.type==='microsoft-todo'?'Tasks.Read':setting.adapter==='calendars'?'Calendars.Read':setting.adapter==='files'?'Files.Read':'Contacts.Read';
    return {kind:'microsoft',oauth:connector.oauth,token:connector.token,scopes:['https://graph.microsoft.com/'+permission]};
  }
  return fail('INVALID_CONFIG','This source uses an externally supplied credential');
}
export function sourceToken(c:Config,source:string):Secret|(()=>Promise<string>){
  const login=sourceAuthorization(c,source);if(login.token)return login.token;
  let token:Promise<string>|undefined;
  return ()=>token??=login.kind==='google'?googleToken(login.oauth!,login.scopes):microsoftToken(login.oauth!,undefined,undefined,login.scopes);
}
