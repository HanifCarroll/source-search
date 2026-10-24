import {readFile} from 'node:fs/promises';
import {regular} from './source-files';
import {fail} from '../domain/identity';

// macOS owns both binary and XML plist decoding. Feed bounded bytes on stdin;
// plutil writes JSON to stdout and never changes the original bookmarks file.
export async function readPlist(path:string):Promise<unknown>{
  if(process.platform!=='darwin')fail('UNSUPPORTED_PLATFORM','Safari bookmarks require macOS');
  const max=8*1024*1024,info=await regular(path);
  if(info.size>max)fail('SOURCE_LIMIT','Property list exceeds 8 MiB');
  const bytes=await readFile(path);if(bytes.length>max)fail('SOURCE_LIMIT','Property list grew beyond 8 MiB');
  const child=Bun.spawn(['/usr/bin/plutil','-convert','json','-o','-','--','-'],{stdin:bytes,stdout:'pipe',stderr:'ignore'});
  const timeout=setTimeout(()=>child.kill(),10000);
  try{
    let output='';const decoder=new TextDecoder();let size=0;
    for await(const chunk of child.stdout){size+=chunk.length;if(size>32*1024*1024){child.kill();fail('SOURCE_LIMIT','Decoded property list exceeds 32 MiB');}output+=decoder.decode(chunk,{stream:true});}
    if(await child.exited!==0)fail('UNSUPPORTED_SCHEMA','Could not decode Safari bookmarks');
    try{return JSON.parse(output+decoder.decode());}catch{return fail('UNSUPPORTED_SCHEMA','Invalid property list JSON');}
  }finally{clearTimeout(timeout);child.kill();}
}
