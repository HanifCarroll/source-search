import {createHash} from 'node:crypto';
import type {HttpResponseRead} from '../../src/platform/http';

type File={text:string|Uint8Array;mode?:string};
type Entry={path:string;mode:string;type:string;sha:string;size?:number};
type Tree={sha:string;tree:Entry[];truncated:boolean};
const hash=(text:string)=>createHash('sha1').update(text).digest('hex');

// An invented Git object graph, with real Git blob hashes. Commits stay
// immutable while branch heads move, including after force pushes.
export function gitFixture(name='example/lab',branch='main'){
  let sequence=0,repositoryId=42;
  const heads=new Map<string,string>(),commits=new Map<string,string>(),trees=new Map<string,Tree>(),blobs=new Map<string,unknown>();
  const requests:string[]=[];
  function commit(files:Record<string,string|File>,target=branch){
    const entries:Entry[]=Object.entries(files).map(([path,value])=>{
      const file=typeof value==='string'?{text:value}:value,bytes=Buffer.from(file.text),mode=file.mode||'100644';
      const sha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
      blobs.set(sha,{sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')});
      return {path,mode,type:mode==='160000'?'commit':'blob',sha,...(mode==='160000'?{}:{size:bytes.length})};
    });
    function build(prefix:string):string{
      const children:Entry[]=[],directories=new Set<string>();
      for(const entry of entries.filter(e=>e.path.startsWith(prefix))){
        const relative=entry.path.slice(prefix.length),slash=relative.indexOf('/');
        if(slash===-1)children.push({...entry,path:relative});
        else directories.add(relative.slice(0,slash));
      }
      for(const directory of directories)children.push({path:directory,mode:'040000',type:'tree',sha:build(prefix+directory+'/')});
      const sha=hash(JSON.stringify(children));trees.set(sha,{sha,tree:children,truncated:false});return sha;
    }
    const root=build(''),sha=hash(root+':commit:'+ ++sequence);commits.set(sha,root);heads.set(target,sha);return {sha,tree:root};
  }
  const http:HttpResponseRead=async path=>{
    requests.push(path);let data:unknown;const prefix='/repos/'+name;
    if(path===prefix)data={id:repositoryId,full_name:name,default_branch:branch,html_url:'https://github.com/'+name};
    else if(path.startsWith(prefix+'/git/ref/heads/')){
      const selected=decodeURIComponent(path.slice((prefix+'/git/ref/heads/').length)),sha=heads.get(selected);
      if(!sha)throw Object.assign(new Error('Missing branch'),{code:'RECORD_NOT_FOUND'});
      data={ref:'refs/heads/'+selected,object:{type:'commit',sha}};
    }else if(path.startsWith(prefix+'/git/commits/')){
      const sha=path.split('/').at(-1)!,tree=commits.get(sha);if(!tree)throw Error('Unknown commit '+sha);data={sha,tree:{sha:tree}};
    }else if(path.startsWith(prefix+'/git/trees/')){
      const sha=path.split('/').at(-1)!.split('?')[0]!,tree=trees.get(sha);if(!tree)throw Error('Unknown tree '+sha);
      function flatten(id:string,prefix=''):Entry[]{return trees.get(id)!.tree.flatMap(e=>[{...e,path:prefix+e.path},...(e.type==='tree'?flatten(e.sha,prefix+e.path+'/'):[])]);}
      data=path.includes('?recursive=1')?{...tree,tree:flatten(sha)}:tree;
    }else if(path.startsWith(prefix+'/git/blobs/'))data=blobs.get(path.split('/').at(-1)!);
    else throw Error('Unexpected GitHub read '+path);
    if(!data)throw Error('Missing fixture response '+path);
    return {data:structuredClone(data),headers:new Headers()};
  };
  return {name,http,commit,requests,heads,setDefaultBranch(value:string){branch=value;},setRepositoryId(value:number){repositoryId=value;}};
}
