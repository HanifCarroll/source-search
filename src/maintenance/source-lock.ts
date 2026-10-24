import {join} from 'node:path';
import {lock} from 'proper-lockfile';
import type {Config} from '../platform/config';
import {privateDirectory,markManagedCache} from '../platform/storage';

export async function withSourceLock<T>(c:Config,name:string,work:(assertOwned:()=>void)=>Promise<T>):Promise<T>{
  await markManagedCache(c.libraryRoot);
  const root=join(c.libraryRoot,'sync-locks');await privateDirectory(root);
  let compromised:Error|undefined;
  const release=await lock(join(root,name),{realpath:false,stale:300000,update:10000,retries:0,onCompromised:e=>{compromised=e;}});
  const assertOwned=()=>{if(compromised)throw compromised;};
  try{const result=await work(assertOwned);assertOwned();return result;}finally{await release();}
}
