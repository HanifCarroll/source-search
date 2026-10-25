import {join} from 'node:path';
import {z} from 'zod';
import {JsonWorker} from '../../platform/json-worker';
import {packageRoot} from '../../platform/package-root';
import type {Config} from '../../platform/config';
import type {Rank} from './pipeline';

const scores=z.array(z.number().finite().min(0).max(1));
export function createTextRanker(settings:NonNullable<Config['searchRanker']>){
  const worker=new JsonWorker([settings.python,join(packageRoot,'src/search/qmd/onnx_ranker.py'),JSON.stringify(settings)],{
    timeoutMs:180000,env:{HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'},
  });
  const rank:Rank=async(query,documents)=>{
    if(!documents.length)return [];
    const unique=[...new Set(documents.map(d=>d.text))];
    const result=scores.parse(await worker.request({query,documents:unique}));
    if(result.length!==unique.length)throw Error('Ranker returned an incomplete score list');
    const byText=new Map(unique.map((text,i)=>[text,result[i]!]));
    return documents.map(document=>({file:document.file,score:byText.get(document.text)!}));
  };
  return {rank,close:()=>worker.close()};
}
