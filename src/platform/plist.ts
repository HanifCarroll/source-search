import {readFile} from 'node:fs/promises';
import {parse} from 'plist';
import {regular} from './source-files';
import {fail} from '../domain/identity';

// plist handles binary/XML values, including Safari's date and data metadata
// that cannot be represented by plutil's JSON conversion.
export async function readPlist(path:string):Promise<unknown>{
  const max=8*1024*1024,info=await regular(path);
  if(info.size>max)fail('SOURCE_LIMIT','Property list exceeds 8 MiB');
  const bytes=await readFile(path);if(bytes.length>max)fail('SOURCE_LIMIT','Property list grew beyond 8 MiB');
  try{return parse(bytes.subarray(0,8).toString()==='bplist00'?bytes:bytes.toString('utf8'));}catch{return fail('UNSUPPORTED_SCHEMA','Could not decode Safari bookmarks');}
}
