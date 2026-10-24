import {test,expect} from 'bun:test';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {googleTasksProvider,googleTasksScope} from '../src/sources/tasks/google-tasks';
import {googleToken} from '../src/platform/google-auth';
import {providerHttp} from '../src/platform/http';
import {configSchema,sourceScope} from '../src/platform/config';
import {syncTasks} from '../src/maintenance/sources';
import {createRuntime} from '../src/application/runtime';

test('Google Tasks includes completed/hidden/assigned items, follows pagination and applies edits and tombstones',async()=>{
  let phase=0;const seen:string[]=[];
  const provider=googleTasksProvider('google',['list-a'],async path=>{
    seen.push(path);
    if(path.startsWith('/users/'))return {items:[{id:'list-a',title:'Research'}]};
    if(path.includes('/tasks/task-a'))return {id:'task-a',title:'Invented telescope',status:'completed',updated:'2026-10-20T10:00:00Z'};
    expect(path).toContain('showHidden=true');expect(path).toContain('showCompleted=true');expect(path).toContain('showAssigned=true');
    if(phase===1)return {items:[{id:'task-a',deleted:true}]};
    if(path.includes('pageToken='))return {items:[{id:'task-a',title:'Invented telescope',notes:'Compare aperture',status:'completed',updated:'2026-10-20T10:00:00Z',due:'2026-11-02T00:00:00Z'}]};
    return {nextPageToken:'next'};
  });
  const first=await provider.sync();expect(first.records).toHaveLength(1);expect(first.records[0]!.body).toContain('Status: completed');expect(first.records[0]!.body).toContain('Due: 2026-11-02');
  expect(first.records[0]!.task).toMatchObject({status:'completed',dueDate:'2026-11-02',project:{id:'list-a',name:'Research'}});
  expect((await provider.read(first.records[0]!.ref.id)).title).toBe('Invented telescope');
  phase=1;expect((await provider.sync(first.checkpoint)).records).toEqual([]);expect(seen.some(p=>p.includes('updatedMin='))).toBe(true);
  expect((first.checkpoint as any).lists[0].items).toHaveLength(1);
});

test('Google task references survive token rotation and shared snapshot failures retain searchable originals',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-google-tasks-'));
  try{
    const definition={adapter:'tasks',connector:{type:'google-tasks',account:'invented',token:{env:'INVENTED_GOOGLE_TOKEN'}}};
    const c=configSchema.parse({enabledSources:['google'],maintenanceEnabled:true,libraryRoot:root,sources:{google:definition}});
    const changed=configSchema.parse({...c,sources:{google:{...definition,connector:{...definition.connector,token:{file:join(root,'new-token')}}}}});
    expect(sourceScope(c,'google')).toBe(sourceScope(changed,'google'));
    const provider=googleTasksProvider('google',undefined,async path=>path.startsWith('/users/')?{items:[{id:'list',title:'Research'}]}:{items:[{id:'task',title:'Invented cobalt telescope',status:'needsAction',updated:'2026-10-20T10:00:00Z'}]});
    expect((await syncTasks(c,undefined,()=>provider)).ok).toBe(true);
    expect((await createRuntime(c).search_sources({queries:[{source:'all-tasks',query:'cobalt'}]})).results[0]!.items).toHaveLength(1);
    expect((await syncTasks(c,undefined,()=>({...provider,async sync(){throw Object.assign(new Error('Unavailable'),{code:'RATE_LIMITED'});}}))).ok).toBe(false);
    const page=(await createRuntime(c).search_sources({queries:[{source:'google',query:'cobalt'}]})).results[0]!;expect(page.items).toHaveLength(1);expect(page.warnings.join(' ')).toContain('RATE_LIMITED');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Google OAuth uses loopback PKCE, keeps credentials private and refuses account changes or silent consent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-google-auth-'));
  try{
    const options={clientId:'invented.apps.googleusercontent.com',cache:join(root,'google.json')};let subject='account-a';
    const client:any={credentials:{},setCredentials(v:any){this.credentials=v;},async generateCodeVerifierAsync(){return {codeVerifier:'invented-verifier',codeChallenge:'invented-challenge'};},
      generateAuthUrl(o:any){expect(o.code_challenge_method).toBe('S256');return 'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({redirect_uri:o.redirect_uri,state:o.state});},
      async getToken(o:any){expect(o.code).toBe('invented-code');expect(o.codeVerifier).toBe('invented-verifier');return {tokens:{access_token:'invented-access',refresh_token:'invented-refresh',id_token:'invented-identity',scope:'openid '+googleTasksScope}};},
      async verifyIdToken(){return {getPayload:()=>({sub:subject})};},async getAccessToken(){return {token:'invented-access'};}};
    const prompt=(url:string)=>{const u=new URL(url),callback=new URL(u.searchParams.get('redirect_uri')!);callback.searchParams.set('state',u.searchParams.get('state')!);callback.searchParams.set('code','invented-code');void fetch(callback);};
    await expect(googleToken(options,[googleTasksScope],undefined,()=>client)).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    expect(await googleToken(options,[googleTasksScope],prompt,()=>client)).toBe('invented-access');expect((await stat(options.cache)).mode&0o777).toBe(0o600);
    const saved=await readFile(options.cache,'utf8');expect(await googleToken(options,[googleTasksScope],undefined,()=>client)).toBe('invented-access');
    await expect(googleToken(options,['other-scope'],undefined,()=>client)).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    subject='account-b';await expect(googleToken(options,[googleTasksScope],prompt,()=>client)).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});expect(await readFile(options.cache,'utf8')).toBe(saved);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('shared HTTP keeps credentials on the fixed origin and reports rate limits without response secrets',async()=>{
  let calls=0;
  const http=providerHttp('https://api.example.test/v1',{token:async()=>'invented',fetch:async(url:any,init:any)=>{
    calls++;expect(String(url)).toBe('https://api.example.test/v1/items');expect(init.headers.Authorization).toBe('Bearer invented');expect(init.redirect).toBe('error');return new Response('private provider detail',{status:429,headers:{'Retry-After':'30'}});
  }});
  await expect(http.json('/items')).rejects.toMatchObject({code:'RATE_LIMITED',message:'Provider returned HTTP 429. Retry after 30 seconds.'});
  for(const path of ['//other.test/items','https://other.test/items','/items#fragment'])await expect(http.json(path)).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});expect(calls).toBe(1);
});
