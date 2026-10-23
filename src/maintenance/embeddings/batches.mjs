// Fill QMD's embedding contexts across document boundaries, while committing
// only complete documents. A failed batch leaves every document in it pending.
export async function embedDocuments({items, prepare, embed, commit, shouldStop = () => false, onProgress = () => {}, batchSize = 32}) {
  let pack = [], chunkCount = 0, documents = 0, vectors = 0;
  const seen = new Set();
  async function flush() {
    const texts = pack.flatMap(item => item.texts), results = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      results.push(...await embed(texts.slice(i, i + batchSize)));
    }
    if (results.length !== texts.length || results.some(e => !e?.embedding?.length)) {
      throw Error('Incomplete embedding response; batch left pending');
    }
    let offset = 0;
    for (const item of pack) {
      await commit(item, results.slice(offset, offset + item.texts.length));
      offset += item.texts.length;
      documents++; vectors += item.texts.length;
    }
    pack = []; chunkCount = 0;
    onProgress({documents, vectors});
  }
  for (const item of items) {
    if (shouldStop()) break;
    if (seen.has(item.hash)) continue;
    seen.add(item.hash);
    const prepared = await prepare(item);
    if (!prepared.texts.length) continue;
    pack.push(prepared); chunkCount += prepared.texts.length;
    if (chunkCount >= batchSize || pack.length >= 32) await flush();
  }
  // Finish the small batch already prepared when shutdown/deadline is requested.
  if (pack.length) await flush();
  return {documents, vectors};
}
