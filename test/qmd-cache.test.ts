import {test,expect} from 'bun:test';
import {join} from 'node:path';

test('index updates reuse unchanged inference while new text and models get fresh scores',async()=>{
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'helpers/qmd-cache-fixture.mjs')],{stdout:'pipe',stderr:'pipe',env:{...process.env,CI:'true',HF_HUB_OFFLINE:'1'}});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code,err).toBe(0);
  expect(JSON.parse(out)).toMatchObject({scored:10});
},15000);
