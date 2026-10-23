import {test, expect} from 'bun:test';
import {rankDocuments, rankingWindows} from '../src/search/qmd/hybrid.mjs';

function ranker(budget) {
 return {
  _getEvaluationInput:(q,d)=>Array.from(`template:${q}:${d}`),
  async rankAll(q,docs) {
   if(docs.some(d=>this._getEvaluationInput(q,d).length>budget))throw Error('overflow');
   return docs.map(d=>d.includes('target') ? 0.9 : 0.1);
  }
 };
}
test('reranking covers an oversized passage using the actual model input budget',async()=>{
 const text='🦋'.repeat(80)+'target';
 const context=ranker(40), windows=rankingWindows('query',text,context,40);
 expect(windows.join('')).toBe(text);
 expect(windows.every(w=>context._getEvaluationInput('query',w).length<=40)).toBe(true);
 const results=await rankDocuments('query',[{file:'one',text}],context,40);
 expect(results).toEqual([{file:'one',index:0,score:0.9}]);
});
test('identical passages retain each original file and result index',async()=>{
 const results=await rankDocuments('query',[{file:'one',text:'target'},{file:'two',text:'target'},{file:'three',text:'else'}],ranker(40),40);
 expect(results).toEqual([{file:'one',index:0,score:0.9},{file:'two',index:1,score:0.9},{file:'three',index:2,score:0.1}]);
});
test('an oversized query fails before GPU evaluation and errors leave no parallel work',async()=>{
 const context=ranker(40);let calls=0;
 context.rankAll=async()=>{calls++;throw Error('model failure');};
 expect(()=>rankingWindows('x'.repeat(50),'body',context,40)).toThrow('Query exceeds');
 expect(calls).toBe(0);
 await expect(rankDocuments('q',[{file:'one',text:'a'},{file:'two',text:'b'}],context,40)).rejects.toThrow('model failure');
 expect(calls).toBe(1);
});
