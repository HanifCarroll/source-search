import {test,expect} from 'bun:test';
import {configureReranker,parseScores,tokenRowsSchema,startRankingWorker} from '../src/search/qmd/reranker';
import {configSchema} from '../src/platform/config';

test('acceleration is optional and requires an explicit local Python path',()=>{
  expect(configSchema.parse({}).searchAcceleration).toBeUndefined();
  expect(configSchema.parse({searchAcceleration:{rerank:'mlx',python:'/invented/python'}}).searchAcceleration?.rerank).toBe('mlx');
  expect(()=>configSchema.parse({searchAcceleration:{rerank:'mlx',python:'python'}})).toThrow();
});

test('the accelerator receives every native template token in document order',async()=>{
  const tokenized:string[]=[],calls:unknown[]=[];
  const context={model:{fileInfo:{metadata:{general:{architecture:'qwen3'}}}},
    _getEvaluationInput:(q:string,d:string)=>{tokenized.push(q+':'+d);return d==='one'?[7,9,11]:[7,8,15,19];},
    rankAll:async(_q:string,_d:string[])=>[0],
  };
  const engine={ensureRerankContexts:async()=>[context]};
  configureReranker(engine,{python:'/invented/python'},'/invented/model.gguf',async(...args)=>{calls.push(args);return [.8,.2];});
  await engine.ensureRerankContexts();await engine.ensureRerankContexts();
  expect(await context.rankAll('query',['one','two'])).toEqual([.8,.2]);
  expect(tokenized).toEqual(['query:one','query:two']);
  expect(calls).toEqual([['/invented/python','/invented/model.gguf',[[7,9,11],[7,8,15,19]]]]);
  expect(await context.rankAll('query',[])).toEqual([]);expect(calls).toHaveLength(1);
});

test('unsupported models, missing contexts and failed inference never silently skip ranking',async()=>{
  const empty={ensureRerankContexts:async()=>[]};configureReranker(empty,{python:'/p'},'/model',async()=>[]);
  await expect(empty.ensureRerankContexts()).rejects.toThrow('tokenizer context');
  const context={model:{fileInfo:{metadata:{general:{architecture:'bert'}}}},_getEvaluationInput:()=>[1],rankAll:async(_q:string,_d:string[])=>[.5]};
  const engine={ensureRerankContexts:async()=>[context]};configureReranker(engine,{python:'/p'},'/model',async()=>[]);
  await expect(engine.ensureRerankContexts()).rejects.toThrow('Qwen3');
  context.model.fileInfo.metadata.general.architecture='qwen3';
  const failing={ensureRerankContexts:async()=>[context]};
  configureReranker(failing,{python:'/p'},'/model',async()=>{throw Error('worker failed');});
  await failing.ensureRerankContexts();await expect(context.rankAll('q',['text'])).rejects.toThrow('worker failed');
});

test('inference boundaries reject lost scores, nonfinite values and oversized tokens',()=>{
  expect(parseScores('[0,0.5,1]',3)).toEqual([0,.5,1]);
  for(const output of ['[]','[0.5]','[0.5,null]','[2,0]','[-1,0]','[1e999,0]','not json'])expect(()=>parseScores(output,2)).toThrow();
  for(const rows of [[],[[]],[[-1]],[[1.5]],[Array(4097).fill(1)],Array(101).fill([1])])expect(()=>tokenRowsSchema.parse(rows)).toThrow();
});

test('ranking workers retain a model process across complete batches',async()=>{
  const code=`import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const {id,input}=JSON.parse(line);console.log('SOURCE_SEARCH_REPLY '+JSON.stringify({id,result:input.rows.map((r,i)=>i/10)}));}`;
  const worker=startRankingWorker([process.execPath,'-e',code]);
  try{expect(await worker.score([[1,2],[3]])).toEqual([0,.1]);expect(await worker.score([[7]])).toEqual([0]);}finally{worker.close();}
  await expect(worker.score([[1]])).rejects.toThrow('closed');
});

test('failed worker startup and timeouts are explicit failures',async()=>{
  const broken=startRankingWorker([process.execPath,'-e',"console.error('invented load failure');process.exit(2)"]);
  try{await expect(broken.score([[1]])).rejects.toThrow('invented load failure');}finally{broken.close();}
  const timed=startRankingWorker([process.execPath,'-e','setInterval(()=>{},1000)'],50);
  try{await expect(timed.score([[1]])).rejects.toThrow('timed out');}finally{timed.close();}
});
