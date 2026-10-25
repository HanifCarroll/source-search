import {test,expect} from 'bun:test';
import {providerHttp} from '../src/platform/http';

const retry={minTimeout:1,maxTimeout:2};
test('provider reads recover transient failures, including read-only POSTs',async()=>{
  for(const status of [429,500,502,503,504]) {
    const calls:RequestInit[]=[];
    const client=providerHttp('https://fixture.invalid',{retry,fetch:async(_url,init)=>{
      calls.push(init!);
      return calls.length===1 ? new Response('',{status,headers:{'Retry-After':'0'}}) : Response.json({items:['fixture']});
    }});
    expect(await client.json('/query',{query:'fixture'})).toEqual({items:['fixture']});
    expect(calls).toHaveLength(2);
    expect(calls.every(c=>c.method==='POST'&&c.body==='{"query":"fixture"}'&&c.redirect==='error')).toBe(true);
  }
  let calls=0;
  const client=providerHttp('https://fixture.invalid',{retry,fetch:async()=>{
    if(++calls===1)throw new TypeError('network unavailable');return Response.json({ok:true});
  }});
  expect(await client.json('/records')).toEqual({ok:true});expect(calls).toBe(2);
});
test('permanent errors, expired state and invalid JSON do not retry',async()=>{
  for(const [status,code] of [[401,'AUTH_REQUIRED'],[403,'AUTH_REQUIRED'],[404,'RECORD_NOT_FOUND'],[410,'SYNC_STATE_EXPIRED'],[200,'INVALID_PROVIDER_RESPONSE']] as const) {
    let calls=0;
    const client=providerHttp('https://fixture.invalid',{retry,fetch:async()=>{calls++;return new Response('not JSON',{status});}});
    await expect(client.json('/records')).rejects.toMatchObject({code});expect(calls).toBe(1);
  }
});
test('interrupted response bodies retry the complete read',async()=>{
  let calls=0;
  const client=providerHttp('https://fixture.invalid',{retry,fetch:async()=>{
    if(++calls>1)return Response.json({complete:true});
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      controller.error(new TypeError('Connection closed during response'));
    }}));
  }});
  expect(await client.json('/records')).toEqual({complete:true});expect(calls).toBe(2);
});
test('attempts share budgets; long Retry-After values are returned without waiting',async()=>{
  for(const header of ['120',new Date(Date.now()+120000).toUTCString()]) {
    let calls=0;
    const client=providerHttp('https://fixture.invalid',{timeoutMs:100,retry,fetch:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':header}});}});
    await expect(client.json('/records')).rejects.toMatchObject({code:'RATE_LIMITED'});expect(calls).toBe(1);
  }
  let calls=0;
  const client=providerHttp('https://fixture.invalid',{maxRequests:2,retry,fetch:async()=>{calls++;return new Response('',{status:503});}});
  await expect(client.json('/records')).rejects.toMatchObject({httpStatus:503});expect(calls).toBe(2);
  await expect(client.json('/records')).rejects.toMatchObject({code:'SOURCE_LIMIT'});expect(calls).toBe(2);
});
test('provider-requested wait and cancellation remain bounded',async()=>{
  let calls=0;
  const started=Date.now();
  const client=providerHttp('https://fixture.invalid',{timeoutMs:2500,retry,fetch:async()=>++calls===1
    ? new Response('',{status:429,headers:{'Retry-After':'1'}}) : Response.json({ok:true})});
  expect(await client.json('/records')).toEqual({ok:true});expect(Date.now()-started).toBeGreaterThanOrEqual(990);
  const abort=new AbortController();let cancelledCalls=0;
  const cancelled=providerHttp('https://fixture.invalid',{signal:abort.signal,retry,fetch:async()=>{
    cancelledCalls++;abort.abort();return new Response('',{status:503});
  }});
  await expect(cancelled.json('/records')).rejects.toThrow();expect(cancelledCalls).toBe(1);
});
