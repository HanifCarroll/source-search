const fields=['source_started_at','date','source','muesli_meeting_id','source_audio','source_locator','backend','model'] as const;
export function frontmatterFields(body:string,additional:readonly string[]=[]):Record<string,string>{
  const match=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(body);
  if(!match)return {};
  const parsed=Bun.YAML.parse(match[1]!);
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))return {};
  return Object.fromEntries([...fields,...additional].flatMap(key=>{
    const value=(parsed as Record<string,unknown>)[key];
    return typeof value==='string' || typeof value==='number' ? [[key,String(value)]] : [];
  }));
}
