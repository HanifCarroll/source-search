import {z} from 'zod';
import {fail,versioned,now} from '../../domain/identity';
import type {HttpResponseRead} from '../../platform/http';
import {checked,pages,identity,identityParts,collectionLink} from '../sync/paging';
import type {SourceProvider} from '../sync/model';

const user=z.object({login:z.string()}).nullable();
const common={id:z.number(),body:z.string().nullish(),user,created_at:z.string(),updated_at:z.string(),html_url:z.string()};
const issue=z.object({...common,number:z.number().int().positive(),title:z.string(),state:z.string(),pull_request:z.record(z.string(),z.any()).optional(),labels:z.array(z.union([z.string(),z.object({name:z.string()})])).optional(),assignees:z.array(z.object({login:z.string()})).optional()});
const comment=z.object({...common,issue_url:z.string().optional(),pull_request_url:z.string().optional(),path:z.string().optional(),diff_hunk:z.string().optional()});
const repository=z.object({name:z.string(),at:z.string(),reconciledAt:z.string(),issues:z.array(issue),comments:z.array(comment),reviews:z.array(comment)});
const state=z.object({version:z.literal(1),repositories:z.array(repository)});
export function githubProvider(source:string,repositories:string[],http:HttpResponseRead,origin='https://api.github.com'):SourceProvider{
  const repoPath=(repo:string)=>'/repos/'+repo.split('/').map(encodeURIComponent).join('/');
  const repositoryIds=new Map<string,number>();
  async function continuation(value:string,repo:string,path:string){
    const relative=path.slice(repoPath(repo).length),numericPrefix=new URL(origin+'/repositories/').pathname;
    if(new URL(value).pathname.startsWith(numericPrefix)){
      // GitHub emits numeric repository URLs in Link headers even when the
      // initial request used owner/name. Resolve that alias before following it.
      let id=repositoryIds.get(repo);if(id===undefined){
        const metadata=checked(z.object({id:z.number().int().positive(),full_name:z.string()}),(await http(repoPath(repo))).data);
        if(metadata.full_name.toLowerCase()!==repo.toLowerCase())fail('INVALID_PROVIDER_RESPONSE','GitHub returned a different repository');
        id=metadata.id;repositoryIds.set(repo,id);
      }
      return collectionLink(value,origin,'/repositories/'+id+relative);
    }
    return collectionLink(value,origin,path);
  }
  async function list(repo:string,path:string,query:string){return (await pages(path+'?'+query,async next=>{const response=await http(next),link=response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);return {items:checked(z.array(z.unknown()),response.data),next:link?await continuation(link[1]!,repo,path):undefined};})).items;}
  function issueNumber(repo:string,c:z.infer<typeof comment>){const url=c.issue_url||c.pull_request_url;if(!url)fail('INVALID_PROVIDER_RESPONSE','GitHub comment has no issue identity');const u=new URL(url),base=new URL(origin+repoPath(repo)),match=u.pathname.slice(base.pathname.length).match(/^\/(?:issues|pulls)\/(\d+)$/);if(u.origin!==base.origin||!u.pathname.startsWith(base.pathname)||!match)fail('INVALID_PROVIDER_RESPONSE','GitHub comment left its selected repository');return Number(match[1]);}
  function issueRecord(repo:string,p:z.infer<typeof issue>){return versioned({adapter:'issues',ref:{source,id:identity([repo,'issue',String(p.number)])},title:`${repo}#${p.number}: ${p.title}`,body:[p.title,`State: ${p.state}`,p.assignees?.length?'Assigned: '+p.assignees.map(v=>v.login).join(', '):'',p.labels?.length?'Labels: '+p.labels.map(v=>typeof v==='string'?v:v.name).join(', '):'',p.body].filter(Boolean).join('\n\n'),type:p.pull_request?'pull-request':'issue',locator:p.html_url,occurredAt:p.created_at,observedAt:now(),author:p.user?.login,conversation:repo+'#'+p.number,metadata:{provider:'github',modifiedAt:p.updated_at}});}
  function commentRecord(repo:string,p:z.infer<typeof comment>,review=false){const number=issueNumber(repo,p);return versioned({adapter:'issues',ref:{source,id:identity([repo,review?'review':'comment',String(p.id)])},title:`${repo}#${number}: ${review?'Review comment':'Comment'} by ${p.user?.login||'deleted user'}`,body:[p.body,p.path&&`File: ${p.path}`,p.diff_hunk].filter(Boolean).join('\n\n'),type:review?'review-comment':'issue-comment',locator:p.html_url,occurredAt:p.created_at,observedAt:now(),author:p.user?.login,conversation:repo+'#'+number,metadata:{provider:'github',modifiedAt:p.updated_at}});}
  return {async sync(previous){
    const parsed=state.safeParse(previous),old=parsed.success?parsed.data:undefined,saved=[],records=[];let repaired=false;
    for(const repo of repositories){const prior=old?.repositories.find(r=>r.name===repo),at=now(),full=!prior||Date.now()-Date.parse(prior.reconciledAt)>86400000,query='per_page=100&sort=updated&direction=asc'+(!full?'&since='+encodeURIComponent(new Date(Date.parse(prior!.at)-60000).toISOString()):'');
      const issues=new Map((full?[]:prior!.issues).map(v=>[v.number,v])),comments=new Map((full?[]:prior!.comments).map(v=>[v.id,v])),reviews=new Map((full?[]:prior!.reviews).map(v=>[v.id,v]));
      for(const v of checked(z.array(issue),await list(repo,repoPath(repo)+'/issues','state=all&'+query)))issues.set(v.number,v);
      for(const v of checked(z.array(comment),await list(repo,repoPath(repo)+'/issues/comments',query)))comments.set(v.id,v);
      for(const v of checked(z.array(comment),await list(repo,repoPath(repo)+'/pulls/comments',query)))reviews.set(v.id,v);
      // Comments can change independently of the issue's updated timestamp.
      for(const c of [...comments.values(),...reviews.values()]){const n=issueNumber(repo,c);if(!issues.has(n)&&!full){try{issues.set(n,checked(issue,(await http(repoPath(repo)+'/issues/'+n)).data));}catch(e){if((e as any).code!=='RECORD_NOT_FOUND')throw e;}}}
      const entry={name:repo,at,reconciledAt:full?at:prior!.reconciledAt,issues:[...issues.values()],comments:[...comments.values()].filter(c=>issues.has(issueNumber(repo,c))),reviews:[...reviews.values()].filter(c=>issues.has(issueNumber(repo,c)))};saved.push(entry);records.push(...entry.issues.map(v=>issueRecord(repo,v)),...entry.comments.map(v=>commentRecord(repo,v)),...entry.reviews.map(v=>commentRecord(repo,v,true)));repaired||=full;
    }
    return {records,checkpoint:{version:1,repositories:saved},strategy:repaired?'full-reconciliation':'updated-since-with-overlap',coverage:'Selected GitHub repositories: open/closed issues, pull request bodies, issue discussions and inline review comments; deletions reconcile daily',warnings:[]};
  },async read(id){const [repo,kind,key]=identityParts(id,3);if(!repositories.includes(repo!)||!/^\d+$/.test(key!))fail('INVALID_REFERENCE','GitHub reference is outside selected repositories');
    if(kind==='issue'){const p=checked(issue,(await http(repoPath(repo!)+'/issues/'+key)).data);if(String(p.number)!==key)fail('INVALID_PROVIDER_RESPONSE','GitHub returned a different issue');return issueRecord(repo!,p);}
    if(kind!=='comment'&&kind!=='review')fail('INVALID_REFERENCE','Unknown GitHub record kind');
    const p=checked(comment,(await http(repoPath(repo!)+(kind==='review'?'/pulls/comments/':'/issues/comments/')+key)).data);if(String(p.id)!==key)fail('INVALID_PROVIDER_RESPONSE','GitHub returned a different comment');return commentRecord(repo!,p,kind==='review');
  }};
}
