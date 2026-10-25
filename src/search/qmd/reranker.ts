import {join} from 'node:path';
import {z} from 'zod';
import {packageRoot} from '../../platform/package-root';

// This adapter is confined to the pinned QMD/node-llama-cpp boundary. QMD still
// selects/truncates chunks and the native tokenizer/template supplies every token.
type RankingContext={
  model:{fileInfo:{metadata?:{general?:{architecture?:string}}}};
  _getEvaluationInput(query:string,document:string):number[];
  rankAll(query:string,documents:string[]):Promise<number[]>;
};
type Engine={ensureRerankContexts():Promise<RankingContext[]>};
export const tokenRowsSchema=z.array(z.array(z.number().int().nonnegative()).min(1).max(4096)).min(1).max(100);
const scoresSchema=z.array(z.number().finite().min(0).max(1));
export function parseScores(output:string,count:number):number[]{
  const scores=scoresSchema.parse(JSON.parse(output));
  if(scores.length!==count)throw Error('Reranker returned an incomplete score list');
  return scores;
}

export function startRankingWorker(command:string[],timeoutMs=180000) {
  const child=Bun.spawn(command,{
    stdin:'pipe',stdout:'pipe',stderr:'pipe',
    env:{...process.env,HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'},
  });
  const stop=()=>child.kill(),timer=setTimeout(stop,timeoutMs);
  const terminate=()=>{stop();process.exit(143);},interrupt=()=>{stop();process.exit(130);};
  process.once('SIGTERM',terminate);process.once('SIGINT',interrupt);process.once('exit',stop);
  const close=()=>{clearTimeout(timer);process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',interrupt);process.removeListener('exit',stop);stop();};
  const bounded=async(stream:ReadableStream<Uint8Array>)=>{
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of stream){size+=chunk.length;if(size>64*1024){stop();throw Error('Reranker output exceeded its budget');}chunks.push(chunk);}
    return Buffer.concat(chunks).toString();
  };
  const result=Promise.all([bounded(child.stdout),bounded(child.stderr),child.exited]);
  // Preloading can fail before retrieval supplies candidates. Keep the failure
  // for score(), without an unhandled rejection or an abandoned process.
  void result.catch(()=>{}).finally(close);
  let used=false;
  return {close,exited:child.exited,score:async(rows:number[][])=>{
    if(used)throw Error('Ranking worker already received its batch');used=true;
    try {
      tokenRowsSchema.parse(rows);
      let writeError:unknown;
      try{child.stdin.write(JSON.stringify({rows}));child.stdin.end();}catch(error){writeError=error;}
      const [out,err,code]=await result;
      if(code!==0)throw Error(`MLX reranking failed: ${err.slice(-800) || 'worker stopped'}`);
      if(writeError)throw writeError;
      return parseScores(out,rows.length);
    } finally {close();}
  }};
}

export function configureReranker(engine:Engine,settings:{python:string;cache?:string},model:string,run?:(python:string,model:string,rows:number[][])=>Promise<number[]>) {
  // Import/load while QMD expands the query and retrieves candidates. This
  // worker belongs to this search only; no daemon or background job is added.
  const worker=run?undefined:startRankingWorker([settings.python,join(packageRoot,'src/search/qmd/mlx_ranker.py'),model,...(settings.cache?[settings.cache]:[])]);
  const execute=run||((_python,_model,rows)=>worker!.score(rows));
  const original=engine.ensureRerankContexts.bind(engine),configured=new WeakSet<RankingContext>();
  engine.ensureRerankContexts=async()=>{
    const contexts=await original();
    if(!contexts.length)throw Error('The configured reranker could not create its tokenizer context');
    for(const context of contexts.slice(0,1)){
      if(configured.has(context))continue;
      if(context.model.fileInfo.metadata?.general?.architecture!=='qwen3')throw Error('MLX acceleration requires a Qwen3 reranker; remove searchAcceleration to use the portable engine');
      context.rankAll=async(query,documents)=>{
        if(!documents.length)return [];
        const rows=documents.map(text=>context._getEvaluationInput(query,text));
        tokenRowsSchema.parse(rows);
        return execute(settings.python,model,rows);
      };
      configured.add(context);
    }
    // MLX owns batching; send the complete candidate set through one process.
    return contexts.slice(0,1);
  };
  return ()=>worker?.close();
}
