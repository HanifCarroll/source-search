import {test,expect} from 'bun:test';
import {githubProvider} from '../src/sources/issues/github';
import {linearProvider} from '../src/sources/issues/linear';
import {identity} from '../src/sources/sync/paging';
import {providerHttp} from '../src/platform/http';

const dates={created_at:'2026-10-01T12:00:00Z',updated_at:'2026-10-24T12:00:00Z'},user={login:'invented'};
test('GitHub follows Link headers, imports PR review comments, updates comments independently and reconciles deletions',async()=>{
  let phase=0;const seen:string[]=[];
  const issue={id:1,number:1,title:'Invented optics',body:'Compare mirrors',state:'closed',pull_request:{},user,html_url:'https://github.com/example/lab/pull/1',...dates};
  const comment={id:2,body:'Use a prism',user,html_url:'https://github.com/example/lab/issues/1#issuecomment-2',issue_url:'https://api.github.com/repos/example/lab/issues/1',...dates};
  const provider=githubProvider('github',['example/lab'],async path=>{
    seen.push(path);let data:unknown=[],link='';
    if(path.endsWith('/issues/1'))data=issue;
    else if(path.endsWith('/issues/comments/2'))data={...comment,body:phase?'Use a lens':comment.body};
    else if(path.includes('/pulls/comments'))data=phase===2?[]:[{...comment,id:3,issue_url:undefined,pull_request_url:'https://api.github.com/repos/example/lab/pulls/1',path:'optics.ts',diff_hunk:'@@ invented @@'}];
    else if(path.includes('/issues/comments'))data=phase===2?[]:[{...comment,body:phase?'Use a lens':comment.body}];
    else if(path.includes('page=2'))data=phase===2?[]:[issue];
    else if(!path.includes('since='))link='<https://api.github.com/repos/example/lab/issues?page=2>; rel="next"';
    return {data,headers:new Headers(link?{link}:{})};
  });
  const first=await provider.sync();expect(first.records.map(r=>r.type)).toEqual(['pull-request','issue-comment','review-comment']);
  phase=1;const updated=await provider.sync(first.checkpoint);expect(updated.records.find(r=>r.type==='issue-comment')!.body).toBe('Use a lens');expect(seen.some(v=>v.includes('since='))).toBe(true);
  expect((await provider.read(identity(['example/lab','comment','2']))).body).toBe('Use a lens');
  phase=2;const stale=structuredClone(updated.checkpoint) as any;stale.repositories[0].reconciledAt='2020-01-01T00:00:00Z';expect((await provider.sync(stale)).records).toHaveLength(0);
  await expect(provider.read(identity(['other/lab','issue','1']))).rejects.toMatchObject({code:'INVALID_REFERENCE'});
});

test('GitHub rejects pagination that leaves the selected repository',async()=>{
  const provider=githubProvider('github',['example/lab'],async()=>({data:[],headers:new Headers({link:'<https://api.github.com/repos/other/private/issues?page=2>; rel="next"'})}));
  await expect(provider.sync()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});
});

test('GitHub resolves numeric repository pagination aliases and rejects a different repository ID',async()=>{
  for(const origin of ['https://api.github.com','https://github.example.test/api/v3'])for(const correct of [true,false]){
    const seen:string[]=[],provider=githubProvider('github',['example/lab'],async path=>{
      seen.push(path);
      if(path==='/repos/example/lab')return {data:{id:42,full_name:'example/lab'},headers:new Headers()};
      const link=path.startsWith('/repos/example/lab/issues?')?`<${origin}/repositories/${correct?42:999}/issues?page=2>; rel="next"`:'';
      return {data:[],headers:new Headers(link?{link}:{})};
    },origin);
    if(correct){expect((await provider.sync()).records).toEqual([]);expect(seen).toContain('/repositories/42/issues?page=2');}
    else{await expect(provider.sync()).rejects.toMatchObject({code:'INVALID_PROVIDER_RESPONSE'});expect(seen.some(v=>v.startsWith('/repositories/999'))).toBe(false);}
  }
});

const issue={id:'i',identifier:'LAB-1',title:'Invented telescope',description:'Mirror tests',url:'https://linear.app/example/issue/LAB-1',createdAt:'2026-10-01T12:00:00Z',updatedAt:'2026-10-24T12:00:00Z',archivedAt:null,dueDate:null,priorityLabel:'High',state:{name:'Started'},assignee:null,team:{id:'team',name:'Lab'},project:null};
const comment={id:'c',body:'Use a prism',url:issue.url+'#comment-c',createdAt:issue.createdAt,updatedAt:issue.updatedAt,archivedAt:null,user:{name:'Invented'},parent:null,issue};
test('Linear polls comments independently, rejects partial GraphQL errors, and checks original team scope',async()=>{
  let phase=0;const calls:any[]=[];
  const provider=linearProvider('linear',{teams:['team']},async(_path,request)=>{
    calls.push(request);const query=String(request!.query),variables=request!.variables as any;
    if(phase===3)return {data:{issues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}},errors:[{extensions:{code:'RATELIMITED'}}]};
    if(query.startsWith('query Issue('))return {data:{issue:{...issue,team:phase===2?{id:'outside',name:'Other'}:issue.team}}};
    if(query.startsWith('query Comment('))return {data:{comment}};
    const key=query.startsWith('query Issues(')?'issues':'comments';expect(variables.filter[key==='issues'?'team':'issue']).toBeDefined();
    if(key==='issues'&&!variables.after&&!phase)return {data:{issues:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'opaque-next'}}}};
    return {data:{[key]:{nodes:key==='issues'?(phase?[]:[issue]):[{...comment,body:phase?'Edited prism':comment.body}],pageInfo:{hasNextPage:false,endCursor:null}}}};
  });
  const first=await provider.sync();expect(first.records).toHaveLength(2);
  phase=1;const updated=await provider.sync(first.checkpoint);expect(updated.records.find(r=>r.type==='issue-comment')!.body).toBe('Edited prism');expect(calls.some(v=>v.variables.filter?.updatedAt)).toBe(true);
  phase=2;await expect(provider.read(identity(['issue','i']))).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
  phase=3;await expect(provider.sync(updated.checkpoint)).rejects.toMatchObject({code:'RATE_LIMITED'});
});
test('shared transport supports Linear API key authentication without adding a bearer prefix',async()=>{
  const http=providerHttp('https://api.linear.app',{token:async()=>'invented-key',tokenScheme:'raw',fetch:async(_url,init)=>{expect((init!.headers as any).Authorization).toBe('invented-key');return Response.json({data:{}});}});
  expect(await http.json('/graphql',{query:'query { viewer { id } }'})).toEqual({data:{}});
});
