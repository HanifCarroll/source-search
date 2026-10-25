import {test,expect} from 'bun:test';
import {JsonWorker} from '../src/platform/json-worker';

const program=`import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const {id,input}=JSON.parse(line);if(input.crash)process.exit(2);if(input.delay)await Bun.sleep(input.delay);if(input.flood){console.log('x'.repeat(10000));continue;}console.log('SOURCE_SEARCH_REPLY '+JSON.stringify({id,result:{pid:process.pid,value:input.value}}));}`;
test('worker reuses a process, serializes requests, expires idle and recovers from a crash',async()=>{
  const worker=new JsonWorker([process.execPath,'-e',program],{idleMs:40});
  try{
    const [one,two]=await Promise.all([worker.request({value:1,delay:10}),worker.request({value:2})]) as any[];
    expect(one.pid).toBe(two.pid);expect([one.value,two.value]).toEqual([1,2]);
    await Bun.sleep(70);const restarted=await worker.request({value:3}) as any;expect(restarted.pid).not.toBe(one.pid);
    await expect(worker.request({crash:true})).rejects.toThrow('exited');
    expect((await worker.request({value:4}) as any).value).toBe(4);
  }finally{worker.close();}
});
test('queued cancellation does not cancel another request; active cancellation stops inference',async()=>{
  const worker=new JsonWorker([process.execPath,'-e',program]);
  try{
    const first=worker.request({value:1,delay:80}),queued=new AbortController();
    const second=worker.request({value:2},{signal:queued.signal});queued.abort();
    await expect(second).rejects.toThrow('cancelled');expect((await first as any).value).toBe(1);
    const active=new AbortController(),third=worker.request({delay:10000},{signal:active.signal});
    setTimeout(()=>active.abort(),20);await expect(third).rejects.toThrow('cancelled');
    expect((await worker.request({value:4}) as any).value).toBe(4);
  }finally{worker.close();}
});
test('output and time budgets fail explicitly and permit a fresh worker',async()=>{
  const worker=new JsonWorker([process.execPath,'-e',program],{maxBytes:1024,timeoutMs:200});
  try{
    await expect(worker.request({flood:true})).rejects.toThrow('output budget');
    await expect(worker.request({delay:1000})).rejects.toThrow('timed out');
    expect((await worker.request({value:1}) as any).value).toBe(1);
  }finally{worker.close();}
});
