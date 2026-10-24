import {OAuth2Client,CodeChallengeMethod,type Credentials} from 'google-auth-library';
import {writeFile,rename,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {lock} from 'proper-lockfile';
import {z} from 'zod';
import type {GoogleOAuth} from './auth-settings';
import {readSecret} from './credentials';
import {privateDirectory} from './storage';
import {textFile} from './source-files';
import {fail} from '../domain/identity';

const savedSchema=z.object({version:z.literal(1),clientId:z.string(),subject:z.string().min(1),scopes:z.array(z.string()),credentials:z.record(z.string(),z.unknown())});
type Client=Pick<OAuth2Client,'credentials'|'setCredentials'|'generateCodeVerifierAsync'|'generateAuthUrl'|'getToken'|'getAccessToken'|'verifyIdToken'>;
type Factory=(options:ConstructorParameters<typeof OAuth2Client>[0])=>Client;

// Only the explicit login opens a loopback listener. The official SDK handles
// PKCE, token exchange, ID-token verification and subsequent silent refresh.
export async function googleToken(options:GoogleOAuth,requested:string[],prompt?:(url:string)=>void,createClient:Factory=o=>new OAuth2Client(o)){
  await privateDirectory(dirname(options.cache));let compromised:Error|undefined;
  const release=await lock(options.cache,{realpath:false,stale:1200000,update:10000,retries:{retries:10,minTimeout:200,maxTimeout:1000},onCompromised:e=>{compromised=e;}});
  try{
    let saved:z.infer<typeof savedSchema>|undefined;
    try{saved=savedSchema.parse(JSON.parse(await textFile(options.cache,4*1024*1024)));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')fail('CREDENTIAL_UNAVAILABLE','Google login cache could not be read');}
    if(saved&&saved.clientId!==options.clientId)fail('AUTH_REQUIRED','Use a separate Google login cache for this client');
    const client=createClient({clientId:options.clientId,clientSecret:options.clientSecret?await readSecret(options.clientSecret):undefined});
    let subject=saved?.subject,scopes=[...new Set([...(saved?.scopes||[]),...requested,'openid'])];
    if(saved)client.setCredentials(saved.credentials as Credentials);
    if(prompt){
      const state=crypto.randomUUID(),verifier=await client.generateCodeVerifierAsync();
      let accept!:(code:string)=>void,reject!:(e:Error)=>void;
      const code=new Promise<string>((resolve,fail)=>{accept=resolve;reject=fail;});
      const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
        const url=new URL(request.url);
        if(request.method!=='GET'||url.pathname!=='/oauth/callback'||url.searchParams.get('state')!==state)return new Response('Invalid sign-in callback',{status:400});
        if(url.searchParams.has('error')){reject(new Error('Sign-in declined'));return new Response('Sign-in was not completed. You can close this tab.');}
        const value=url.searchParams.get('code');if(!value)return new Response('Missing sign-in code',{status:400});
        accept(value);return new Response('Source Search sign-in received. You can close this tab.');
      }});
      const timer=setTimeout(()=>reject(new Error('Sign-in timed out')),300000),redirect_uri=`http://127.0.0.1:${server.port}/oauth/callback`;
      try{
        prompt(client.generateAuthUrl({access_type:'offline',prompt:'consent',scope:scopes,state,redirect_uri,code_challenge:verifier.codeChallenge,code_challenge_method:CodeChallengeMethod.S256}));
        const result=await client.getToken({code:await code,codeVerifier:verifier.codeVerifier,redirect_uri});client.setCredentials(result.tokens);
        if(!result.tokens.id_token)fail('AUTH_REQUIRED','Google sign-in returned no account identity');
        const identity=(await client.verifyIdToken({idToken:result.tokens.id_token,audience:options.clientId})).getPayload();
        if(!identity?.sub)fail('AUTH_REQUIRED','Google sign-in returned no verified account');
        if(subject&&identity.sub!==subject)fail('ACCOUNT_CHANGED','This cache belongs to another Google account; use a new account setting and cache path');
        subject=identity.sub;
      }finally{clearTimeout(timer);await server.stop();}
      if(client.credentials.scope){
        scopes=client.credentials.scope.split(/\s+/);
        if(requested.some(scope=>!scopes.includes(scope)))fail('AUTH_REQUIRED','Google did not grant every permission requested for this source');
      }
    }else if(!saved||requested.some(scope=>!saved.scopes.includes(scope)))fail('AUTH_REQUIRED','Run login-google SOURCE_ID to sign in and grant this source access');
    let token:string|null|undefined;
    try{token=(await client.getAccessToken()).token;}catch{return fail('AUTH_REQUIRED','Google sign-in is required; run login-google SOURCE_ID');}
    if(!token||!subject)fail('AUTH_REQUIRED','Google sign-in returned no access token');
    if(compromised)throw compromised;
    const temp=options.cache+'.'+crypto.randomUUID()+'.tmp';
    try{await writeFile(temp,JSON.stringify({version:1,clientId:options.clientId,subject,scopes,credentials:client.credentials}),{mode:0o600,flag:'wx'});await rename(temp,options.cache);}finally{await rm(temp,{force:true});}
    return token;
  }catch(e){if(['ACCOUNT_CHANGED','AUTH_REQUIRED','CREDENTIAL_UNAVAILABLE','ELOCKED'].includes((e as any).code))throw e;return fail('AUTH_REQUIRED','Google sign-in failed; run login-google SOURCE_ID');}
  finally{await release();}
}
