import {PublicClientApplication} from '@azure/msal-node';
import {writeFile,rename,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import lockfile from 'proper-lockfile';
import {z} from 'zod';
import type {TaskSettings} from './source-settings';
import {privateDirectory} from './storage';
import {textFile} from './source-files';
import {fail} from '../domain/identity';

export type MicrosoftOAuth=NonNullable<Extract<TaskSettings['connector'],{type:'microsoft-todo'}>['oauth']>;
const savedSchema=z.object({version:z.literal(1),clientId:z.string(),tenant:z.string(),homeAccountId:z.string().min(1),cache:z.string()});
const scopes=['https://graph.microsoft.com/Tasks.Read'];
type Client=Pick<PublicClientApplication,'getTokenCache'|'acquireTokenSilent'|'acquireTokenByDeviceCode'>;
type ClientFactory=(options:ConstructorParameters<typeof PublicClientApplication>[0])=>Client;

// MSAL owns OAuth and refresh-token handling. Only the explicit CLI login can
// prompt. Each configured account has a private cache, serialized under a lock.
export async function microsoftToken(options:MicrosoftOAuth,prompt?: (message:string)=>void,createClient:ClientFactory=c=>new PublicClientApplication(c)):Promise<string>{
  await privateDirectory(dirname(options.cache));
  let compromised:Error|undefined;
  const release=await lockfile.lock(options.cache,{realpath:false,stale:1200000,update:10000,retries:{retries:10,minTimeout:200,maxTimeout:1000},onCompromised:e=>{compromised=e;}});
  try{
    let saved:z.infer<typeof savedSchema>|undefined;
    try{saved=savedSchema.parse(JSON.parse(await textFile(options.cache,4*1024*1024)));}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')fail('CREDENTIAL_UNAVAILABLE','Microsoft login cache could not be read');}
    if(saved&&(saved.clientId!==options.clientId||saved.tenant!==options.tenant))fail('AUTH_REQUIRED','Use a separate Microsoft login cache for this app or tenant');
    const client=createClient({auth:{clientId:options.clientId,authority:'https://login.microsoftonline.com/'+options.tenant},system:{loggerOptions:{loggerCallback:()=>{},piiLoggingEnabled:false}}});
    if(saved){try{client.getTokenCache().deserialize(saved.cache);}catch{fail('CREDENTIAL_UNAVAILABLE','Microsoft login cache is invalid; sign in with a new cache file');}}
    let result;
    try{
      if(prompt)result=await client.acquireTokenByDeviceCode({scopes,timeout:300,deviceCodeCallback:response=>prompt(response.message)});
      else{
        const account=saved&&await client.getTokenCache().getAccountByHomeId(saved.homeAccountId);
        if(!account)fail('AUTH_REQUIRED','Run login-microsoft SOURCE_ID to sign in');
        result=await client.acquireTokenSilent({account,scopes});
      }
    }catch{fail('AUTH_REQUIRED','Microsoft sign-in is required; run login-microsoft SOURCE_ID');}
    if(!result?.account||!result.accessToken)fail('AUTH_REQUIRED','Microsoft sign-in returned no account or access token');
    if(saved&&saved.homeAccountId!==result.account.homeAccountId)fail('ACCOUNT_CHANGED','This cache belongs to another Microsoft account; use a new account setting and cache path');
    if(compromised)throw compromised;
    const data=JSON.stringify({version:1,clientId:options.clientId,tenant:options.tenant,homeAccountId:result.account.homeAccountId,cache:client.getTokenCache().serialize()});
    if(data.length>4*1024*1024)fail('CREDENTIAL_UNAVAILABLE','Microsoft login cache exceeds 4 MiB');
    const temporary=options.cache+'.'+crypto.randomUUID()+'.tmp';
    try{await writeFile(temporary,data,{mode:0o600,flag:'wx'});await rename(temporary,options.cache);}finally{await rm(temporary,{force:true});}
    return result.accessToken;
  }finally{await release();}
}
