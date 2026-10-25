import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configSchema} from '../src/platform/config';
import {runSdk,disposeSearchWorkers} from '../src/search/qmd/runner';

test('searching more indexes replaces idle workers and keeps the new index warm',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-worker-pool-')),binary=join(root,'fake-bun');
 disposeSearchWorkers();
 try{
  // Exercise the real subprocess lifecycle without loading models or accounts.
  await writeFile(binary,`#!${process.execPath}
import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})){
 const {id,input}=JSON.parse(line);
 if(input.query==='hold'){
  await Bun.write(input.database+'.holding','');
  while(!await Bun.file(input.database+'.release').exists())await Bun.sleep(10);
 }
 console.log('SOURCE_SEARCH_REPLY '+JSON.stringify({id,result:{pid:process.pid}}));
}
`);await chmod(binary,0o700);
  const configs=Array.from({length:5},(_,i)=>{
   const path=join(root,`index-${i}.sqlite`),db=new Database(path);db.exec('CREATE TABLE fixture(id INTEGER)');db.close();
   return configSchema.parse({bunBinary:binary,qmdDatabase:path});
  });
  const search=(i:number)=>runSdk(configs[i]!,{index:'vault',mode:'lexical',query:'invented'});
  const first=await search(0);for(const i of [1,2,3])await search(i);
  expect((await search(0)).pid).toBe(first.pid); // Index zero is most recently used.
  const fifth=await search(4);
  expect((await search(4)).pid).toBe(fifth.pid);
  expect((await search(0)).pid).toBe(first.pid);
  disposeSearchWorkers();
  const initial=[];for(const i of [0,1,2,3])initial.push((await search(i)).pid);
  const held=configs.slice(0,4).map(c=>runSdk(c,{index:'vault',mode:'lexical',query:'hold'}));
  for(const c of configs.slice(0,4)){
   const marker=Bun.file(c.qmdDatabase+'.holding');
   for(let i=0;i<100&&!await marker.exists();i++)await Bun.sleep(10);
   expect(await marker.exists()).toBe(true);
  }
  await search(4); // All retained workers are busy; this request uses overflow.
  await Promise.all(configs.slice(0,4).map(c=>writeFile(c.qmdDatabase+'.release','')));
  expect((await Promise.all(held)).map(r=>r.pid)).toEqual(initial);
  expect((await Promise.all([0,1,2,3].map(search))).map(r=>r.pid)).toEqual(initial);
 }finally{disposeSearchWorkers();await rm(root,{recursive:true,force:true});}
});
