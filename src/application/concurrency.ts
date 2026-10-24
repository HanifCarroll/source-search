export async function boundedMap<T,R>(items:readonly T[],work:(item:T)=>Promise<R>,concurrency=4):Promise<R[]> {
  const result:R[]=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(next<items.length){const index=next++;result[index]=await work(items[index]!);}}));
  return result;
}
