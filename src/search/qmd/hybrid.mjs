// QMD 1.0.7 adapter. Executed in Node because its SQLite/LLM bindings are native.
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// Use the ranking model's complete templated input, not the embedding tokenizer's
// estimate. Score every window and keep the strongest; never discard a candidate.
export function rankingWindows(query, text, context, budget = 4096) {
  const fits = value => context._getEvaluationInput(query, value).length <= budget;
  if (!fits('')) throw Error('Query exceeds the reranker context budget');
  if (fits(text)) return [text];
  const chars = Array.from(text), windows = [];
  let offset = 0;
  while (offset < chars.length) {
    let low = 0, high = chars.length - offset;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(chars.slice(offset, offset + mid).join(''))) low = mid;
      else high = mid - 1;
    }
    if (!low) throw Error('Query leaves no room for reranking document text');
    windows.push(chars.slice(offset, offset + low).join(''));
    if (windows.length > 64) throw Error('Passage exceeds the reranking window budget');
    offset += low;
  }
  return windows;
}
export async function rankDocuments(query, documents, context, budget = 4096) {
  const results = [];
  for (const [index, doc] of documents.entries()) {
    // Sequential GPU work means an error cannot leave another evaluation running
    // while the caller disposes its context. Keep positional identity for duplicates.
    const scores = await context.rankAll(query, rankingWindows(query, doc.text, context, budget));
    results.push({file:doc.file, index, score:Math.max(...scores)});
  }
  return results.sort((a,b) => b.score - a.score);
}
export async function main() {
  process.umask(0o077);
  let input = '';
  for await (const data of process.stdin) { input += data; if (input.length > 65536) throw Error('Search input exceeds budget'); }
  const config = JSON.parse(input), base = config.packagePath;
  if (!base || !isAbsolute(base)) throw Error('Configure an absolute qmdPackage path');
  if (JSON.parse(readFileSync(join(base,'package.json'),'utf8')).version !== '1.0.7') throw Error('Review the hybrid adapter after upgrading QMD');
  if (config.models?.length !== 3 || !config.models.every(existsSync)) throw Error('Install QMD models before searching');
  const {createStore, hybridQuery, extractSnippet} = await import(pathToFileURL(join(base,'dist/store.js')));
  const {LlamaCpp, setDefaultLlamaCpp, disposeDefaultLlamaCpp} = await import(pathToFileURL(join(base,'dist/llm.js')));
  class BoundedRanker extends LlamaCpp {
    async ensureRerankContexts() {
      if (!this.rerankContexts.length) {
        const model = await this.ensureRerankModel();
        // One larger context keeps memory bounded and avoids parallel error teardown.
        this.rerankContexts.push(await model.createRankingContext({contextSize:4096}));
      }
      return this.rerankContexts;
    }
    async rerank(query, documents) {
      this.touchActivity();
      const [context] = await this.ensureRerankContexts();
      return {results:await rankDocuments(query,documents,context),model:this.rerankModelUri};
    }
  }
  setDefaultLlamaCpp(new BoundedRanker());
  let store;
  try {
    store = createStore(config.database);
    const results = await hybridQuery(store, config.query, {limit:100, collection:config.collection});
    console.log(JSON.stringify(results.map(r => ({file:r.file, score:r.score, title:r.title, snippet:extractSnippet(r.body,config.query,500,r.bestChunkPos,r.bestChunk.length).snippet}))));
  } finally { store?.close(); await disposeDefaultLlamaCpp(); }
}
