import {test,expect} from 'bun:test';
import {hybridSearch} from '../src/search/qmd/pipeline';
import {querySchema} from '../src/domain/contracts';
import {validateOptions} from '../src/domain/query';

function fixture(){
  let expanded=0;const queries:string[]=[],ranked:string[][]=[];
  const body='cobalt introduction'.padEnd(500,' ')+ 'A telescope uses mirrors to collect light.';
  const h={filepath:'qmd://selected/one.md',title:'Invented optics',body,score:.8};
  const internal={db:{prepare:()=>({get:()=>true})},llm:{embedModelName:'fixture',embedBatch:async(texts:string[])=>texts.map(()=>({embedding:[1,0]}))},
    searchFTS:(query:string,_limit:number,collections:string[])=>{queries.push('lex:'+query);expect(collections).toEqual(['selected']);return [h];},
    searchVec:async(query:string,_model:string,_limit:number,collections:string[])=>{queries.push('vec:'+query);expect(collections).toEqual(['selected']);return [{...h,chunkPos:500}];},
    expandQuery:async()=>{expanded++;return [{type:'lex',query:'optics'}];},
    rerank:async(_query:string,docs:{file:string;text:string}[])=>{ranked.push(docs.map(d=>d.text));return docs.map(doc=>({file:doc.file,score:doc.text.includes('mirrors')?.9:.2}));},
  };
  const weights:number[][]=[];
  const primitives={formatQueryForEmbedding:(q:string)=>q,chunkDocument:(text:string)=>[{pos:0,text:text.slice(0,500)},...(text.length>500?[{pos:500,text:text.slice(500)}]:[])],reciprocalRankFusion:(lists:any[][],w:number[])=>{weights.push(w);return lists[0]!;}};
  return {store:{internal},primitives,queries,ranked,weights,body,get expanded(){return expanded;}};
}
test('supplied variants keep original retrieval weights and semantic passages through ranking',async()=>{
  const f=fixture(),plan={lexical:['optics','cobalt'],semantic:['mirrors collect light']};
  const hits=await hybridSearch(f.store,{query:'cobalt',collections:['selected'],plan},f.primitives);
  expect(f.expanded).toBe(0);
  expect(f.queries).toEqual(['lex:cobalt','lex:optics','vec:cobalt','vec:mirrors collect light']);
  expect(f.weights).toEqual([[2,1,2,1]]);
  expect(f.ranked[0]).toHaveLength(2);expect(f.ranked[0]!.some(p=>p.includes('mirrors'))).toBe(true);
  expect(hits[0]!.bestChunkPos).toBe(500);expect(hits[0]!.bestChunk).toContain('mirrors');
});
test('plain searches and deep searches share retrieval and differ only in requested inference',async()=>{
  const normal=fixture();await hybridSearch(normal.store,{query:'cobalt',collections:['selected']},normal.primitives);expect(normal.expanded).toBe(0);
  const deep=fixture();await hybridSearch(deep.store,{query:'cobalt',collections:['selected'],depth:'deep'},deep.primitives);expect(deep.expanded).toBe(1);expect(deep.queries).toContain('lex:optics');
  const supplied=fixture();await hybridSearch(supplied.store,{query:'cobalt',collections:['selected'],depth:'deep',plan:{lexical:['optics'],semantic:[]}},supplied.primitives);expect(supplied.expanded).toBe(0);
});
test('a vector boundary inside a ranking chunk retains the evidence after that chunk ends',async()=>{
  const f=fixture();
  f.store.internal.searchVec=async()=>[{filepath:'qmd://selected/one.md',title:'Invented optics',body:f.body,score:.8,chunkPos:350}];
  const hits=await hybridSearch(f.store,{query:'cobalt',collections:['selected']},f.primitives);
  expect(hits[0]!.bestChunkPos).toBe(350);expect(hits[0]!.bestChunk).toContain('mirrors');
});
test('missing or malformed ranking and embedding results never silently reduce recall',async()=>{
  const f=fixture();
  await expect(hybridSearch(f.store,{query:'cobalt',collections:['selected']},f.primitives,async()=>[])).rejects.toThrow('omitted');
  await expect(hybridSearch(f.store,{query:'cobalt',collections:['selected']},f.primitives,async()=>[{file:'unknown',score:1}])).rejects.toThrow('invalid');
  f.store.internal.llm.embedBatch=async()=>[];
  await expect(hybridSearch(f.store,{query:'cobalt',collections:['selected']},f.primitives)).rejects.toThrow('incomplete');
});
test('query plans are bounded, scoped to supported retrieval and part of the query contract',()=>{
  const q=querySchema.parse({source:'library',query:'invented',plan:{lexical:[' optics ']}});
  expect(q.plan).toEqual({lexical:['optics'],semantic:[]});expect(()=>validateOptions(q)).not.toThrow();
  for(const option of [{source:'messages'},{mode:'lexical'},{source:'agent-history'}])expect(()=>validateOptions(querySchema.parse({...q,...option}))).toThrow('require hybrid');
  for(const plan of [{lexical:['']},{semantic:Array(4).fill('invented')},{extra:true}])expect(()=>querySchema.parse({...q,plan})).toThrow();
});
test('fusion retains forty candidates, including evidence beyond the first twenty',async()=>{
  const f=fixture();
  f.primitives.reciprocalRankFusion=()=>Array.from({length:55},(_,i)=>({file:`qmd://selected/${i}.md`,title:'Invented',body:i===35?'The evidence is late.':'Other text',score:1/(i+1)}));
  f.primitives.chunkDocument=(body:string)=>[{pos:0,text:body}];
  const files:string[]=[];
  const hits=await hybridSearch(f.store,{query:'evidence',collections:['selected']},f.primitives,async(_q,docs)=>{
    files.push(...docs.map(d=>d.file));return docs.map(d=>({file:d.file,score:d.text.includes('late')?.99:.01}));
  });
  expect(files).toHaveLength(40);expect(new Set(files).size).toBe(40);
  expect(hits.findIndex(h=>h.file==='qmd://selected/35.md')).toBeLessThan(5);
});
