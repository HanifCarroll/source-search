import {test,expect} from 'bun:test';
import {join} from 'node:path';

test('SDK vector retrieval keeps scoped recall without repeated index scans',async()=>{
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'helpers/qmd-vector-fixture.mjs')],{stdout:'pipe',stderr:'pipe',env:{...process.env,CI:'true',HF_HUB_OFFLINE:'1'}});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code,err).toBe(0);
  expect(JSON.parse(out)).toMatchObject({semantic:3,hybrid:10});
},15000);
