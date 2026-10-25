import type {Query} from '../../domain/contracts';

type Hit={filepath:string;file?:string;title:string;body:string;score:number;chunkPos?:number};
type Candidate={file:string;title:string;body:string;score:number};
type Passage={text:string;pos:number};
export type RankInput={file:string;text:string};
export type Rank=(query:string,documents:RankInput[])=>Promise<{file:string;score:number}[]>;
type Store={internal:{db:{prepare(sql:string):{get():unknown}};llm:{embedModelName:string;embedBatch(texts:string[]):Promise<({embedding:number[]}|null)[]>};searchFTS(query:string,limit:number,collections:string[]):Hit[];searchVec(query:string,model:string,limit:number,collections:string[],session:undefined,embedding:number[]):Promise<Hit[]>;expandQuery(query:string):Promise<{type:string;query:string}[]>;rerank:Rank}};
type Primitives={formatQueryForEmbedding(query:string,model:string):string;chunkDocument(body:string):Passage[];reciprocalRankFusion(lists:Candidate[][],weights:number[]):Candidate[]};
type Request={query:string;collections:string[];plan?:Query['plan'];depth?:Query['depth']};

// One policy for both supplied plans and locally expanded deep searches. QMD
// owns tokenization, embedding, retrieval, chunking and reciprocal-rank fusion.
export async function hybridSearch(store:Store,request:Request,primitives:Primitives,rank:Rank=store.internal.rerank.bind(store.internal)){
  const {query,collections}=request,s=store.internal;
  const variants=request.plan
    ? [...request.plan.lexical.map(query=>({type:'lex',query})),...request.plan.semantic.map(query=>({type:'vec',query}))]
    : request.depth==='deep'?await s.expandQuery(query):[];
  const unique=[...new Map(variants.filter(v=>v.query.trim()&&v.query.trim()!==query.trim()).map(v=>[v.type+':'+v.query.trim(),{...v,query:v.query.trim()}])).values()];
  const lists:Candidate[][]=[],weights:number[]=[],semantic=new Map<string,{pos:number;score:number}>();
  function collect(hits:Hit[],weight:number,vector=false){
    if(!hits.length)return;
    lists.push(hits.map(hit=>({file:hit.filepath,title:hit.title,body:hit.body||'',score:hit.score})));weights.push(weight);
    if(vector)for(const hit of hits){
      const previous=semantic.get(hit.filepath);
      if(hit.chunkPos!==undefined&&(!previous||hit.score>previous.score))semantic.set(hit.filepath,{pos:hit.chunkPos,score:hit.score});
    }
  }
  collect(s.searchFTS(query,20,collections),2);
  for(const variant of unique)if(variant.type==='lex')collect(s.searchFTS(variant.query,20,collections),1);
  if(s.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vectors_vec'").get()){
    const queries=[{query,weight:2},...unique.filter(v=>v.type==='vec'||v.type==='hyde').map(v=>({query:v.query,weight:1}))];
    const model=s.llm.embedModelName;
    const embeddings=await s.llm.embedBatch(queries.map(q=>primitives.formatQueryForEmbedding(q.query,model)));
    for(let i=0;i<queries.length;i++){
      const embedding=embeddings[i]?.embedding;
      if(!embedding)throw Error('Embedding model returned an incomplete query batch');
      collect(await s.searchVec(queries[i]!.query,model,20,collections,undefined,embedding),queries[i]!.weight,true);
    }
  }
  const candidates=primitives.reciprocalRankFusion(lists,weights).slice(0,40);
  if(!candidates.length)return [];
  const terms=[...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)||[])];
  const inputs:RankInput[]=[],passages=new Map<string,{candidate:number;passage:Passage}>();
  candidates.forEach((candidate,index)=>{
    const chunks=primitives.chunkDocument(candidate.body);
    if(!chunks.length)return;
    let lexical=chunks[0]!,lexicalScore=-1;
    for(const chunk of chunks){
      const lower=chunk.text.toLocaleLowerCase(),score=terms.reduce((sum,term)=>sum+Number(lower.includes(term)),0);
      if(score>lexicalScore){lexical=chunk;lexicalScore=score;}
    }
    const match=semantic.get(candidate.file);
    const vector=match?chunks.findLast(chunk=>chunk.pos<=match.pos&&match.pos<chunk.pos+chunk.text.length):undefined;
    const selected=vector?[vector,...(lexicalScore>0&&lexical.pos!==vector.pos?[lexical]:[])]:[lexical];
    for(const passage of selected){
      const file=JSON.stringify([index,passage.pos]);
      inputs.push({file,text:passage.text});passages.set(file,{candidate:index,passage});
    }
  });
  const ranked=await rank(query,inputs),best=new Map<number,{score:number;passage:Passage}>(),seen=new Set<string>();
  for(const result of ranked){
    const selected=passages.get(result.file);
    if(!selected||seen.has(result.file)||!Number.isFinite(result.score)||result.score<0||result.score>1)throw Error('Ranker returned invalid passage scores');
    seen.add(result.file);
    const previous=best.get(selected.candidate);
    if(!previous||result.score>previous.score)best.set(selected.candidate,{score:result.score,passage:selected.passage});
  }
  if(seen.size!==inputs.length)throw Error('Ranker omitted candidate passages');
  return candidates.flatMap((candidate,index)=>{
    const selected=best.get(index);if(!selected)return [];
    const position=index+1,weight=position<=3?.75:position<=10?.6:.4;
    return [{...candidate,score:weight/position+(1-weight)*selected.score,bestChunk:selected.passage.text,bestChunkPos:selected.passage.pos}];
  }).sort((a,b)=>b.score-a.score);
}
