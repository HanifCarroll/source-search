import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gitFixture} from './helpers/git';
import {repositorySettings} from '../src/platform/connected-settings';
import {githubRepositoryProvider} from '../src/sources/repositories/github';
import {identity} from '../src/sources/sync/paging';
import {snapshotStore} from '../src/sources/sync/cache';
import {syncConnected} from '../src/maintenance/connected';
import {configSchema,sourceScope} from '../src/platform/config';
import {createRuntime} from '../src/application/runtime';
import {textPage} from '../src/domain/results';
import {providerHttp,type HttpResponseRead} from '../src/platform/http';

const definition={adapter:'repositories',connector:{type:'github',account:'invented',token:{env:'INVENTED_TOKEN'},repositories:['example/lab']}};
const settings=(overrides:Record<string,unknown>={})=>repositorySettings.parse({...definition,...overrides});

test('repository selection is explicit, unique and independent of discovery',async()=>{
  const options=settings({connector:{...definition.connector,repositories:[]}}),seen:string[]=[];
  const provider=githubRepositoryProvider('code',options,async path=>{
    seen.push(path);return {data:[{full_name:path.includes('page=2')?'another/project':'example/lab',private:true,default_branch:'main'}],headers:new Headers(path.includes('page=2')?{}:{link:'<https://api.github.com/user/repos?page=2>; rel="next"'})};
  });
  expect((await provider.lists!()).map(v=>v.id)).toEqual(['example/lab','another/project']);
  seen.length=0;await expect(provider.sync()).rejects.toMatchObject({code:'SOURCE_NOT_CONFIGURED'});expect(seen).toEqual([]);
  expect(settings({connector:{...definition.connector,repositories:['Example/Lab',{name:'another/PROJECT',branch:'release/v2'}]}}).connector.repositories).toEqual([{name:'example/lab'},{name:'another/project',branch:'release/v2'}]);
  for(const repositories of [['example/lab','Example/Lab'],['../lab'],[{name:'example/lab',branch:'../main'}]])expect(()=>settings({connector:{...definition.connector,repositories}})).toThrow();
  for(const link of ['https://other.example.test/user/repos?page=2','https://api.github.com/orgs/private/repos?page=2','https://api.github.com/user/repos?per_page=100&sort=full_name&direction=asc']){
    const bad=githubRepositoryProvider('code',options,async()=>({data:[],headers:new Headers({link:`<${link}>; rel="next"`})}));
    await expect(bad.lists!()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
  }
});

test('repository files include exact UTF-8 source and hidden paths, with explicit exclusions and immutable links',async()=>{
  const fixture=gitFixture(),head=fixture.commit({
    'README.md':'---\ntitle: Invented frontmatter\n---\nTelescope notes',
    'src/optics.ts':'export const mirror = (x: number) => x * 2;\n',
    '.github/workflows/check.yml':'name: Invented check',
    'bin/tool':{text:'#!/bin/sh\necho invented',mode:'100755'},
    'node_modules/pkg/index.js':'excluded dependency','dist/bundle.js':'excluded output','bun.lock':'excluded lock',
    'book.EPUB':'book','image.png':{text:new Uint8Array([137,80,0,78])},
    'invalid.txt':{text:new Uint8Array([0xff,0xfe,0xfa])},
    'large.txt':'x'.repeat(201),'link':{text:'src/optics.ts',mode:'120000'},'submodule':{text:'invented',mode:'160000'},
    'asset.lfs':'version https://git-lfs.github.com/spec/v1\noid sha256:invented\nsize 3000\n',
  });
  const options=settings({maxFileBytes:200}),provider=githubRepositoryProvider('code',options,fixture.http),snapshot=await provider.sync();
  expect(snapshot.records.map(r=>r.title).sort()).toEqual(['.github/workflows/check.yml','README.md','bin/tool','src/optics.ts'].map(p=>'example/lab/'+p).sort());
  const file=snapshot.records.find(r=>r.title.endsWith('/optics.ts'))!;
  expect(file.body).toBe('export const mirror = (x: number) => x * 2;\n');expect(file.type).toBe('repository-file');expect(file.occurredAt).toBeUndefined();
  expect(file.locator).toBe('https://github.com/example/lab/blob/'+head.sha+'/src/optics.ts');
  const markdown=snapshot.records.find(r=>r.title.endsWith('/README.md'))!;
  expect(markdown.sections).toEqual([{kind:'primary',start:0,end:markdown.body.length}]);
  expect(snapshot.coverage).toContain('2 binary');expect(snapshot.coverage).toContain('1 oversized');expect(snapshot.coverage).toContain('2 symlinks/submodules');expect(snapshot.coverage).toContain('1 lfs');
  expect(fixture.requests.filter(p=>p.includes('/git/blobs/'))).toHaveLength(7);
  const narrowed=await githubRepositoryProvider('code',settings({include:['src/**'],exclude:[]}),fixture.http).sync();
  expect(narrowed.records).toHaveLength(1);expect(narrowed.records[0]!.ref).toEqual(file.ref);
});

test('unchanged heads skip content, changed heads reuse blobs, and edits, deletions, renames and force pushes reconcile',async()=>{
  const fixture=gitFixture(),initial=fixture.commit({'keep.ts':'prism','edit.ts':'old','remove.ts':'gone'}),provider=githubRepositoryProvider('code',settings(),fixture.http);
  const first=await provider.sync();fixture.requests.length=0;
  const same=await provider.sync(first.checkpoint);expect(same.strategy).toBe('unchanged-branch-heads');expect(same.records.map(r=>r.ref)).toEqual(first.records.map(r=>r.ref));
  expect(fixture.requests).toEqual(['/repos/example/lab','/repos/example/lab/git/ref/heads/main']);
  fixture.commit({'keep.ts':'prism','edit.ts':'new','renamed.ts':'gone','new.ts':'added'});fixture.requests.length=0;
  const second=await provider.sync(first.checkpoint);expect(second.records.map(r=>r.title)).toEqual(['keep.ts','edit.ts','renamed.ts','new.ts'].map(p=>'example/lab/'+p));
  expect(fixture.requests.filter(p=>p.includes('/git/blobs/'))).toHaveLength(2);
  expect(second.records[0]!.ref).toEqual(first.records[0]!.ref);expect(second.records[1]!.ref.version).not.toBe(first.records[1]!.ref.version);
  fixture.heads.set('main',initial.sha);
  expect((await provider.sync(second.checkpoint)).records.map(r=>r.ref)).toEqual(first.records.map(r=>r.ref));
  fixture.commit({'next.ts':'new default'},'next');fixture.setDefaultBranch('next');
  const next=await provider.sync(second.checkpoint);expect(next.records).toHaveLength(1);expect(next.records[0]!.metadata?.branch).toBe('next');
});

test('truncated recursive trees are replaced by a complete pinned subtree walk',async()=>{
  const fixture=gitFixture();fixture.commit({'README.md':'root','src/a.ts':'one','src/nested/b.ts':'two','node_modules/pkg/index.js':'excluded'});
  const http:HttpResponseRead=async path=>{const response=await fixture.http(path);return path.includes('?recursive=1')?{...response,data:{...(response.data as any),truncated:true,tree:[]}}:response;};
  const snapshot=await githubRepositoryProvider('code',settings(),http).sync();expect(snapshot.records.map(r=>r.body)).toEqual(['root','one','two']);
  expect(fixture.requests.filter(p=>p.includes('/git/trees/'))).toHaveLength(4);
  const incomplete:HttpResponseRead=async path=>{const response=await fixture.http(path);return path.includes('/git/trees/')?{...response,data:{...(response.data as any),truncated:true}}:response;};
  await expect(githubRepositoryProvider('code',settings(),incomplete).sync()).rejects.toMatchObject({code:'SOURCE_LIMIT'});
});

test('provider rejects mismatched repositories, refs, commits, duplicate paths and corrupt blobs',async()=>{
  for(const target of ['repository','ref','commit','tree','blob']){
    const fixture=gitFixture();fixture.commit({'file.ts':'invented code'});
    const http:HttpResponseRead=async path=>{
      const response=await fixture.http(path),data=response.data as any;
      if(target==='repository'&&path==='/repos/example/lab')data.full_name='other/private';
      if(target==='ref'&&path.includes('/git/ref/'))data.ref='refs/heads/other';
      if(target==='commit'&&path.includes('/git/commits/'))data.sha='0'.repeat(40);
      if(target==='tree'&&path.includes('/git/trees/'))data.tree.push(data.tree[0]);
      if(target==='blob'&&path.includes('/git/blobs/'))data.content=Buffer.from('different!!!x').toString('base64');
      return response;
    };
    await expect(githubRepositoryProvider('code',settings(),http).sync()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
  }
});

test('named branches, encoded paths and Enterprise API prefixes work through the shared transport',async()=>{
  const fixture=gitFixture('example/lab','release/v2');fixture.commit({'src/my file #1.ts':'optics'});
  const origin='https://git.example.test/api/v3',options=settings({connector:{...definition.connector,apiUrl:origin,repositories:[{name:'example/lab',branch:'release/v2'}]}});
  const http=providerHttp(origin,{token:async()=>'invented',fetch:async(url,init)=>{
    expect(String(url)).toStartWith(origin+'/repos/example/lab');expect(init!.method).toBe('GET');expect((init!.headers as any).Authorization).toBe('Bearer invented');
    return Response.json((await fixture.http(String(url).slice(origin.length))).data);
  }});
  const provider=githubRepositoryProvider('enterprise',options,http.page),snapshot=await provider.sync();
  expect(fixture.requests).toContain('/repos/example/lab/git/ref/heads/release%2Fv2');
  expect(snapshot.records[0]!.locator).toEndWith('/src/my%20file%20%231.ts');
  expect((await provider.read(snapshot.records[0]!.ref.id,snapshot.checkpoint)).ref).toEqual(snapshot.records[0]!.ref);
  await expect(provider.read(identity(['example/lab','default','src/my file #1.ts']))).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
});

test('references follow current file versions and enforce repository, account, branch and path selection',async()=>{
  const fixture=gitFixture();fixture.commit({'a.ts':'unchanged','b.ts':'old'});
  const provider=githubRepositoryProvider('code',settings(),fixture.http),first=await provider.sync(),a=first.records[0]!,b=first.records[1]!;
  fixture.commit({'a.ts':'unchanged','b.ts':'edited','c.ts':'new'});
  expect((await provider.read(a.ref.id,first.checkpoint)).ref).toEqual(a.ref);
  expect((await provider.read(b.ref.id,first.checkpoint)).ref.version).not.toBe(b.ref.version);
  fixture.commit({'a.ts':'unchanged'});await expect(provider.read(b.ref.id,first.checkpoint)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
  fixture.requests.length=0;
  for(const id of [identity(['another/repo','default','a.ts']),identity(['example/lab','branch:private','a.ts']),identity(['example/lab','default','../a.ts'])])await expect(provider.read(id,first.checkpoint)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
  expect(fixture.requests).toEqual([]);
  const selected=settings({exclude:['a.ts']});await expect(githubRepositoryProvider('code',selected,fixture.http).read(a.ref.id)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});expect(fixture.requests).toEqual([]);
  const renamedAccount=settings({connector:{...definition.connector,account:'different'}});
  expect((await githubRepositoryProvider('code',renamedAccount,fixture.http).read(a.ref.id)).ref.version).not.toBe(a.ref.version);
  fixture.setRepositoryId(99);expect((await provider.read(a.ref.id)).ref.version).not.toBe(a.ref.version);
});

test('repository snapshots reuse runtime search, pagination, filters and failed-sync retention',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-repositories-'));
  try{
    const fixture=gitFixture();fixture.commit({'src/a.ts':'// Invented optics\n'+('line\n'.repeat(2500))+'export const prism = (x: number) => x * 2;\n','src/b.ts':'// Invented optics\nexport const lens = 1;'});
    const c=configSchema.parse({enabledSources:['code'],maintenanceEnabled:true,libraryRoot:root,sources:{code:definition}}),provider=githubRepositoryProvider('code',settings(),fixture.http),runtime=createRuntime(c),store=snapshotStore(c,'code');
    expect((await syncConnected(c,'code',()=>provider)).ok).toBe(true);
    const status=(await runtime.list_sources()).sources.find(s=>s.source==='code')!;expect(status.state).toBe('ready');expect(status.capabilities.filters).toEqual(['types','sections']);
    const page=(await runtime.search_sources({queries:[{source:'all-repositories',query:'optics',limit:1}]})).results[0]!;expect(page.items).toHaveLength(1);expect(page.nextCursor).toBeDefined();
    const continuation=(await runtime.search_sources({queries:[{source:'code',query:'optics',limit:1,cursor:page.nextCursor}]})).results[0]!;expect(continuation.items).toHaveLength(1);expect(continuation.items[0]!.ref.id).not.toBe(page.items[0]!.ref.id);
    const phrase=(await runtime.search_sources({queries:[{source:'all-files',query:'(x: number) => x * 2;',match:'phrase'}]})).results[0]!;
    expect(phrase.items).toHaveLength(1);const hit=phrase.items[0]!,original=await store.original(hit.ref,provider),focused=textPage(original,undefined,hit.focus);
    expect(focused.page.offset).toBeGreaterThan(0);expect(focused.body).toContain('(x: number) => x * 2;');
    const first=textPage(original);expect(first.truncated).toBe(true);expect(first.body+textPage(original,first.nextCursor).body).toBe(original.body);
    for(const query of [{from:'2026-01-01T00:00:00Z'},{sort:'newest'},{conversation:'example/lab'}])expect((await runtime.search_sources({queries:[{source:'code',query:'optics',...query}]})).results[0]!.error?.code).toBe('UNSUPPORTED_FILTER');
    const failed=await syncConnected(c,'code',()=>({...provider,async sync(){throw Object.assign(new Error('Invented disconnect'),{code:'PROVIDER_UNAVAILABLE'});}}));expect(failed.ok).toBe(false);
    const stale=(await runtime.search_sources({queries:[{source:'code',query:'optics'}]})).results[0]!;expect(stale.items).toHaveLength(2);expect(stale.warnings.join(' ')).toContain('PROVIDER_UNAVAILABLE');
    fixture.commit({'src/a.ts':'changed','src/b.ts':'// Invented optics'});
    await expect(store.original(hit.ref,provider)).rejects.toMatchObject({code:'STALE_RECORD'});
    const denied=configSchema.parse({...c,enabledSources:[]});expect((await createRuntime(denied).search_sources({queries:[{source:'all-repositories',query:'optics'}]})).results[0]!.error?.code).toBe('SOURCE_DISABLED');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('adding a selected repository preserves unchanged file references after refresh; removal closes cached access',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-repository-selection-'));
  try{
    const a=gitFixture(),b=gitFixture('other/project');a.commit({'a.ts':'Invented prism'});b.commit({'b.ts':'Invented lens'});
    const http:HttpResponseRead=path=>path.startsWith('/repos/example/lab')?a.http(path):b.http(path);
    const c=configSchema.parse({enabledSources:['code'],maintenanceEnabled:true,libraryRoot:root,sources:{code:definition}});
    const provider=githubRepositoryProvider('code',settings(),http);await syncConnected(c,'code',()=>provider);
    const ref=(await snapshotStore(c,'code').read())!.records[0]!.ref;
    const added=settings({connector:{...definition.connector,repositories:['example/lab','other/project']}}),c2=configSchema.parse({...c,sources:{code:added}});
    expect((await createRuntime(c2).search_sources({queries:[{source:'code',query:'prism'}]})).results[0]!.error?.code).toBe('STALE_INDEX');
    const provider2=githubRepositoryProvider('code',added,http);await syncConnected(c2,'code',()=>provider2);
    expect((await snapshotStore(c2,'code').original(ref,provider2)).ref).toEqual(ref);expect((await snapshotStore(c2,'code').read())!.records).toHaveLength(2);
    const removed=settings({connector:{...definition.connector,repositories:['other/project']}}),c3=configSchema.parse({...c,sources:{code:removed}}),provider3=githubRepositoryProvider('code',removed,http);
    await expect(snapshotStore(c3,'code').original(ref,provider3)).rejects.toMatchObject({code:'STALE_INDEX'});
    await syncConnected(c3,'code',()=>provider3);await expect(snapshotStore(c3,'code').original(ref,provider3)).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
    const rotated=configSchema.parse({...c,sources:{code:{...definition,sync:{timeoutMs:1800000,maxRequests:20000},connector:{...definition.connector,token:{env:'OTHER_TOKEN'}}}}});expect(sourceScope(c,'code')).toBe(sourceScope(rotated,'code'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('byte limits fail the whole synchronization and retain its previous complete snapshot',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-repository-limit-'));
  try{
    const fixture=gitFixture();fixture.commit({'a.ts':'old'});
    const options=settings({maxTotalBytes:5}),c=configSchema.parse({enabledSources:['code'],maintenanceEnabled:true,libraryRoot:root,sources:{code:options}}),provider=githubRepositoryProvider('code',options,fixture.http);
    await syncConnected(c,'code',()=>provider);const before=(await snapshotStore(c,'code').read())!;
    fixture.commit({'a.ts':'1234','b.ts':'5678'});const result=await syncConnected(c,'code',()=>provider);
    expect(result.ok).toBe(false);expect(result.sources[0]!.error?.code).toBe('SOURCE_LIMIT');
    const after=(await snapshotStore(c,'code').read())!;expect(after.records).toEqual(before.records);expect(after.checkpoint).toEqual(before.checkpoint);
  }finally{await rm(root,{recursive:true,force:true});}
});
