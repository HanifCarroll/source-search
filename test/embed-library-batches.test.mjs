import {test} from 'node:test';
import assert from 'node:assert/strict';
import {embedDocuments} from '../src/maintenance/embeddings/batches.mjs';

const items = [{hash:'one', texts:['a','b']}, {hash:'two', texts:['c']}, {hash:'one', texts:['duplicate']}, {hash:'three', texts:['d','e','f']}];
const prepare = async item => item;
const vector = text => ({embedding:[text.charCodeAt(0)]});
test('batches across documents, deduplicates hashes, and maps vectors to their originals', async () => {
  const batches = [], commits = [];
  const result = await embedDocuments({items, prepare, batchSize:4,
    embed:async texts => {batches.push(texts); return texts.map(vector);},
    commit:async (item, vectors) => commits.push([item.hash, vectors.map(v => v.embedding[0])])});
  assert.deepEqual(batches, [['a','b','c','d'],['e','f']]);
  assert.deepEqual(commits, [['one',[97,98]],['two',[99]],['three',[100,101,102]]]);
  assert.deepEqual(result, {documents:3,vectors:6});
});
test('a failed later vector batch does not mark a partially embedded document complete', async () => {
  const commits = [];
  await assert.rejects(embedDocuments({items, prepare, batchSize:4,
    embed:async texts => texts.includes('f') ? texts.map(() => null) : texts.map(vector),
    commit:async item => commits.push(item.hash)}), /Incomplete/);
  assert.deepEqual(commits, []);
});
test('shutdown finishes the prepared batch and leaves later documents pending', async () => {
  let stopped = false; const commits = [];
  const result = await embedDocuments({items, prepare:async item => {stopped=true;return item;},
    shouldStop:() => stopped, embed:async texts => texts.map(vector),
    commit:async item => commits.push(item.hash)});
  assert.deepEqual(commits,['one']);assert.equal(result.vectors,2);
});
