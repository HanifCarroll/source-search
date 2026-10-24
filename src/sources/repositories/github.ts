import {identifiers} from '../../domain/identifiers';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {RepositorySettings} from '../../platform/connected-settings';
import type {HttpResponseRead} from '../../platform/http';
import {fail,hash,now,stableJson,versioned} from '../../domain/identity';
import {checked,collectionLink,identity,identityParts,pages} from '../sync/paging';
import type {SourceProvider} from '../sync/model';

type Options=Pick<RepositorySettings,'include'|'exclude'|'maxFileBytes'|'maxTotalBytes'> & {
  connector:Pick<RepositorySettings['connector'],'account'|'apiUrl'|'repositories'>;
};
type Selection=Options['connector']['repositories'][number];
const sha=z.string().regex(/^[a-f0-9]{40}$/);
const pathSchema=z.string().min(1).max(2048).refine(v=>!v.includes('\0')&&v.split('/').every(p=>p&&p!=='.'&&p!=='..'));
const entrySchema=z.object({path:pathSchema,sha,mode:z.string(),type:z.enum(['blob','tree','commit']),size:z.number().int().nonnegative().optional()});
type Entry=z.infer<typeof entrySchema>;
const treeSchema=z.object({sha,tree:z.array(entrySchema),truncated:z.boolean()});
const repositorySchema=z.object({id:z.number().int().positive(),full_name:z.string(),default_branch:z.string().min(1),html_url:z.url().refine(v=>new URL(v).protocol==='https:')});
type Repository=z.infer<typeof repositorySchema>;
const contentSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('text'),text:z.string()}),
  z.object({kind:z.enum(['binary','lfs'])}),
]);
type Content=z.infer<typeof contentSchema>;
const savedRepository=z.object({name:z.string(),repositoryId:z.number(),branch:z.string(),head:sha,tree:sha,entries:z.array(entrySchema),blobs:z.record(sha,contentSchema)});
const checkpointSchema=z.object({version:z.literal(1),selection:z.string(),repositories:z.array(savedRepository)});
type SavedRepository=z.infer<typeof savedRepository>;
const maximumEntries=100000;
const repoPath=(name:string)=>'/repos/'+name.split('/').map(encodeURIComponent).join('/');
const branchKey=(selection:Selection)=>selection.branch===undefined?'default':'branch:'+selection.branch;

// Git objects provide complete, commit-consistent inventories and stable file
// revisions. Search, pagination and publication remain in the shared modules.
export function githubRepositoryProvider(source:string,options:Options,http:HttpResponseRead):SourceProvider {
  const {connector}=options,include=options.include.map(p=>new Bun.Glob(p)),exclude=options.exclude.map(p=>new Bun.Glob(p));
  const selectionKey=hash(stableJson({include:options.include,exclude:options.exclude,maxFileBytes:options.maxFileBytes,account:connector.account,apiUrl:connector.apiUrl}));
  const allowed=(path:string)=>include.some(p=>p.match(path))&&!exclude.some(p=>p.match(path))&&!/\.(epub|mobi|azw3?|fb2|djvu)$/i.test(path);
  const read=async(path:string)=>(await http(path)).data;
  const trees=new Map<string,Promise<z.infer<typeof treeSchema>>>();
  async function repository(name:string){
    const result=checked(repositorySchema,await read(repoPath(name)));
    if(result.full_name.toLowerCase()!==name.toLowerCase())fail('INVALID_PROVIDER_RESPONSE','GitHub returned a different repository');
    return result;
  }
  async function head(meta:Repository,selection:Selection){
    const branch=selection.branch??meta.default_branch;
    const result=checked(z.object({ref:z.string(),object:z.object({type:z.literal('commit'),sha})}),await read(repoPath(selection.name)+'/git/ref/heads/'+encodeURIComponent(branch)));
    if(result.ref!=='refs/heads/'+branch)fail('INVALID_PROVIDER_RESPONSE','GitHub returned a different branch');
    return {branch,sha:result.object.sha};
  }
  async function commitTree(name:string,commit:string){
    const result=checked(z.object({sha,tree:z.object({sha})}),await read(repoPath(name)+'/git/commits/'+commit));
    if(result.sha!==commit)fail('INVALID_PROVIDER_RESPONSE','GitHub returned a different commit');
    return result.tree.sha;
  }
  function tree(name:string,id:string,recursive=false){
    const key=name+'/'+id+(recursive?'?recursive=1':'');
    let promise=trees.get(key);if(!promise){promise=(async()=>{
      const value=checked(treeSchema,await read(repoPath(name)+'/git/trees/'+id+(recursive?'?recursive=1':'')));
      if(value.sha!==id||new Set(value.tree.map(e=>e.path)).size!==value.tree.length)fail('INVALID_PROVIDER_RESPONSE','GitHub returned an inconsistent file tree');
      return value;
    })();trees.set(key,promise);}return promise;
  }
  async function inventory(name:string,root:string){
    const recursive=await tree(name,root,true);
    if(!recursive.truncated){if(recursive.tree.length>maximumEntries)fail('SOURCE_LIMIT','Repository exceeds 100,000 tree entries');return recursive.tree.filter(e=>e.type!=='tree');}
    const queue=[{sha:root,prefix:'',depth:0}],entries:Entry[]=[];let count=0;
    // A truncated recursive response is not a complete snapshot. Walk its
    // pinned subtrees instead; never publish the partial recursive response.
    for(let i=0;i<queue.length;i++){
      const next=queue[i]!;if(next.depth>64)fail('SOURCE_LIMIT','Repository exceeds 64 directory levels');
      const current=await tree(name,next.sha);
      if(current.truncated)fail('SOURCE_LIMIT','GitHub truncated a directory; previous snapshot retained');
      for(const entry of current.tree){
        if(++count>maximumEntries)fail('SOURCE_LIMIT','Repository exceeds 100,000 tree entries');
        if(entry.path.includes('/'))fail('INVALID_PROVIDER_RESPONSE','Non-recursive tree contains a nested path');
        const path=next.prefix+entry.path;
        if(entry.type==='tree'){
          if(!exclude.some(p=>p.match(path+'/')))queue.push({sha:entry.sha,prefix:path+'/',depth:next.depth+1});
        }else entries.push({...entry,path:checked(pathSchema,path)});
      }
    }
    return entries;
  }
  async function findEntry(name:string,root:string,path:string){
    const parts=path.split('/');let id=root;
    for(let i=0;i<parts.length;i++){
      const current=await tree(name,id);if(current.truncated)fail('SOURCE_LIMIT','GitHub truncated the file directory');
      const entry=current.tree.find(e=>e.path===parts[i]);
      if(!entry)fail('RECORD_NOT_FOUND','File is no longer on the selected branch');
      if(i===parts.length-1)return {...entry,path};
      if(entry.type!=='tree')fail('RECORD_NOT_FOUND','File is no longer on the selected branch');id=entry.sha;
    }
    return fail('INVALID_REFERENCE','Invalid repository file path');
  }
  function skip(entry:Entry){
    if(!allowed(entry.path))return 'path exclusions';
    if(entry.type!=='blob'||!['100644','100755'].includes(entry.mode))return 'symlinks/submodules';
    if(entry.size===undefined)fail('INVALID_PROVIDER_RESPONSE','GitHub omitted a file size');
    return entry.size>options.maxFileBytes?'oversized files':undefined;
  }
  async function content(name:string,entry:Entry):Promise<Content>{
    const blob=checked(z.object({sha,size:z.number().int().nonnegative(),encoding:z.literal('base64'),content:z.string()}),await read(repoPath(name)+'/git/blobs/'+entry.sha));
    if(blob.sha!==entry.sha||blob.size!==entry.size)fail('INVALID_PROVIDER_RESPONSE','GitHub returned a different file blob');
    const bytes=Buffer.from(blob.content,'base64');
    if(bytes.length!==blob.size||bytes.length>options.maxFileBytes||createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==entry.sha)fail('INVALID_PROVIDER_RESPONSE','GitHub file content does not match its revision');
    if(bytes.includes(0))return {kind:'binary'};
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return {kind:'binary'};}
    if(/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(text))return {kind:'lfs'};
    return {kind:'text',text};
  }
  function record(meta:Repository,selection:Selection,branch:string,commit:string,entry:Entry,text:string){
    return versioned({adapter:'repositories',ref:{source,id:identity([selection.name,branchKey(selection),entry.path])},
      title:meta.full_name+'/'+entry.path,body:text,type:'repository-file',observedAt:now(),
      locator:meta.html_url+'/blob/'+commit+'/'+entry.path.split('/').map(encodeURIComponent).join('/'),
      // The locator pins the observed commit. The record version uses the blob,
      // so an unrelated commit or adding another repository keeps it readable.
      identifiers:identifiers('repository',[meta.full_name]),metadata:{provider:'github',account:connector.account,apiUrl:connector.apiUrl,repository:meta.full_name,repositoryId:meta.id,branch,path:entry.path,blobSha:entry.sha,mode:entry.mode,bytes:entry.size},
      sections:[{kind:'primary',start:0,end:text.length}],
    });
  }
  function previous(value:unknown){const parsed=checkpointSchema.safeParse(value);return parsed.success&&parsed.data.selection===selectionKey?parsed.data:undefined;}
  return {
    async lists(){
      const path='/user/repos';const found=await pages(path+'?per_page=100&sort=full_name&direction=asc',async next=>{
        const response=await http(next),link=response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/);
        return {items:checked(z.array(z.object({full_name:z.string(),private:z.boolean(),default_branch:z.string()})),response.data),next:link?collectionLink(link[1]!,connector.apiUrl,path):undefined};
      });
      return found.items.map(v=>({id:v.full_name,name:`${v.full_name} (${v.private?'private':'public'}; default branch: ${v.default_branch})`}));
    },
    async sync(value){
      if(!connector.repositories.length)fail('SOURCE_NOT_CONFIGURED','Choose repositories in connector.repositories, then run sync-sources');
      const old=previous(value),saved:SavedRepository[]=[],records=[],skipped:Record<string,number>={};let bytes=0,changed=false;
      for(const selection of connector.repositories){
        const meta=await repository(selection.name),current=await head(meta,selection);
        const prior=old?.repositories.find(v=>v.name===selection.name&&v.branch===current.branch&&v.repositoryId===meta.id);
        const unchanged=prior?.head===current.sha,root=unchanged?prior.tree:await commitTree(selection.name,current.sha);
        const entries=unchanged?prior.entries:await inventory(selection.name,root),blobs:SavedRepository['blobs']={};changed||=!unchanged;
        for(const entry of entries){
          const reason=skip(entry);if(reason){skipped[reason]=(skipped[reason]||0)+1;continue;}
          const blob=blobs[entry.sha]??prior?.blobs[entry.sha]??await content(selection.name,entry);blobs[entry.sha]=blob;
          if(blob.kind!=='text'){skipped[blob.kind]=(skipped[blob.kind]||0)+1;continue;}
          bytes+=Buffer.byteLength(blob.text);if(bytes>options.maxTotalBytes)fail('SOURCE_LIMIT','Selected repository text exceeds maxTotalBytes; narrow include/exclude or raise the limit');
          records.push(record(meta,selection,current.branch,current.sha,entry,blob.text));
          if(records.length>maximumEntries)fail('SOURCE_LIMIT','Selected repositories exceed 100,000 files');
        }
        saved.push({name:selection.name,repositoryId:meta.id,branch:current.branch,head:current.sha,tree:root,entries,blobs});
      }
      return {records,checkpoint:{version:1,selection:selectionKey,repositories:saved},strategy:changed?'git-tree-and-blob-revisions':'unchanged-branch-heads',warnings:[],
        coverage:`Selected repositories/branches and path patterns; tracked UTF-8 text/code up to ${options.maxFileBytes} bytes per file. No commit history, binary contents, submodules, symlink targets or LFS downloads. Skipped: ${Object.entries(skipped).map(([reason,count])=>`${count} ${reason}`).join(', ')||'none'}.`};
    },
    async read(id,value){
      const [name,key,path]=identityParts(id,3),selection=connector.repositories.find(v=>v.name===name&&branchKey(v)===key);
      if(!selection||!pathSchema.safeParse(path).success||!allowed(path!))fail('RECORD_NOT_FOUND','Repository file is outside the selected repositories, branch or paths');
      const meta=await repository(selection.name),current=await head(meta,selection),prior=previous(value)?.repositories.find(v=>v.name===selection.name&&v.branch===current.branch&&v.repositoryId===meta.id&&v.head===current.sha);
      const entry=prior?prior.entries.find(v=>v.path===path):await findEntry(selection.name,await commitTree(selection.name,current.sha),path!);
      if(!entry||skip(entry))fail('RECORD_NOT_FOUND','File is outside the selected text scope');
      const blob=await content(selection.name,entry);if(blob.kind!=='text')fail('RECORD_NOT_FOUND','File is no longer supported text');
      return record(meta,selection,current.branch,current.sha,entry,blob.text);
    },
  };
}
