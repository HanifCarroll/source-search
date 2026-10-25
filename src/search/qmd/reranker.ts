import {join} from 'node:path';
import {z} from 'zod';
import {packageRoot} from '../../platform/package-root';
import {JsonWorker} from '../../platform/json-worker';

// This adapter is confined to the pinned QMD/node-llama-cpp boundary. Passage
// selection happens upstream; the native tokenizer/template supplies every token.
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
  const worker=new JsonWorker(command,{timeoutMs,env:{HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'}});
  return {close:()=>worker.close(),score:async(rows:number[][])=>{
    tokenRowsSchema.parse(rows);
    const result=await worker.request({rows});
    return parseScores(JSON.stringify(result),rows.length);
  }};
}

export function configureReranker(engine:Engine,settings:{python:string;cache?:string},model:string,run?:(python:string,model:string,rows:number[][])=>Promise<number[]>) {
  // The worker belongs to this SDK session and reuses weights across queries.
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
