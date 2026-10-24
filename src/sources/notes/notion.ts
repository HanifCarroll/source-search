import {z} from 'zod';
import type {HttpRead} from '../../platform/http';
import type {SourceProvider} from '../sync/model';
import {checked,pages} from '../sync/paging';
import {versioned,now,fail} from '../../domain/identity';

const raw=z.record(z.string(),z.any());
const pageSchema=z.object({object:z.literal('page'),id:z.string(),last_edited_time:z.string(),created_time:z.string(),url:z.string(),properties:raw,parent:raw,archived:z.boolean().optional(),in_trash:z.boolean().optional()});
type Page=z.infer<typeof pageSchema>;
const entry=z.object({page:pageSchema,markdown:z.string(),checkedAt:z.string(),warnings:z.array(z.string())});
const state=z.object({version:z.literal(1),pages:z.array(entry)});
const text=(v:any[])=>v.map(p=>p.plain_text??p.text?.content??'').join('');
function property(value:any):string{
  const v=value[value.type];if(v===null||v===undefined)return '';
  if(['title','rich_text'].includes(value.type))return text(v);
  if(['select','status'].includes(value.type))return v.name||'';
  if(value.type==='multi_select')return v.map((p:any)=>p.name).join(', ');
  if(value.type==='date')return [v.start,v.end].filter(Boolean).join(' — ');
  if(['number','checkbox','url','email','phone_number'].includes(value.type))return String(v);
  if(value.type==='people')return v.map((p:any)=>p.name||p.id).join(', ');
  return '';
}
export function notionProvider(source:string,selection:{pages:string[];dataSources:string[]},http:HttpRead):SourceProvider{
  const allowed=(p:Page)=>selection.pages.includes(p.id)||selection.dataSources.includes(p.parent.data_source_id);
  async function content(id:string){
    const queue=[id],seen=new Set<string>(),parts:string[]=[],warnings:string[]=[];let bytes=0;
    while(queue.length){const next=queue.shift()!;if(seen.has(next))continue;seen.add(next);if(seen.size>1000)fail('SOURCE_LIMIT','Notion page exceeds 1,000 content subtrees');
      let value:unknown;try{value=await http('/pages/'+encodeURIComponent(next)+'/markdown');}catch(e){if(next===id||(e as any).code!=='RECORD_NOT_FOUND')throw e;warnings.push('Some Notion content is not shared with this connection');continue;}
      const p=checked(z.object({id:z.string(),markdown:z.string(),truncated:z.boolean(),unknown_block_ids:z.array(z.string()),warnings:z.array(z.object({code:z.string(),message:z.string()})).optional()}),value);
      if(p.id!==next)fail('INVALID_PROVIDER_RESPONSE','Notion returned a different content identity');
      bytes+=Buffer.byteLength(p.markdown);if(bytes>8*1024*1024)fail('SOURCE_LIMIT','Notion page exceeds 8 MiB');parts.push(p.markdown);
      if(p.truncated&&!p.unknown_block_ids.some(v=>!seen.has(v)))fail('INCOMPLETE_SOURCE','Notion truncated a page without a continuation subtree');
      queue.push(...p.unknown_block_ids.filter(v=>!seen.has(v)));
      if(/<unknown\b/.test(p.markdown))warnings.push('Notion markdown may omit unsupported or inaccessible blocks; open the page for embedded content');
      if(p.warnings?.length)warnings.push('Notion reported content warnings: '+p.warnings.map(v=>v.code).join(', '));
    }return {markdown:parts.join('\n\n'),warnings:[...new Set(warnings)]};
  }
  function record(p:Page,markdown:string){
    const title=Object.values(p.properties).find(v=>v.type==='title'),name=title?property(title):'(Untitled page)';
    return versioned({adapter:'notes',ref:{source,id:p.id},title:name,body:[name,...Object.entries(p.properties).filter(([,v])=>v.type!=='title').map(([key,v])=>{const t=property(v);return t?key+': '+t:'';}).filter(Boolean),markdown].join('\n\n'),type:'note',locator:p.url,occurredAt:p.created_time,observedAt:now(),metadata:{provider:'notion',modifiedAt:p.last_edited_time}});
  }
  return {async sync(previous){
    const parsed=state.safeParse(previous),old=new Map((parsed.success?parsed.data.pages:[]).map(v=>[v.page.id,v])),available=new Map<string,Page>(),warnings:string[]=[];
    for(const id of selection.pages){try{const p=checked(pageSchema,await http('/pages/'+encodeURIComponent(id)));if(p.id!==id)fail('INVALID_PROVIDER_RESPONSE','Notion returned a different page');available.set(id,p);}catch(e){if((e as any).code!=='RECORD_NOT_FOUND')throw e;warnings.push('A selected Notion page is removed or no longer shared');}}
    for(const id of selection.dataSources){const result=await pages('first',async cursor=>{const p=checked(z.object({results:z.array(pageSchema),has_more:z.boolean(),next_cursor:z.string().nullable()}),await http('/data_sources/'+encodeURIComponent(id)+'/query',{page_size:100,...(cursor==='first'?{}:{start_cursor:cursor})}));if(p.has_more&&!p.next_cursor)fail('INCOMPLETE_SOURCE','Notion omitted its continuation cursor');return {items:p.results,next:p.has_more?p.next_cursor!:undefined};});for(const p of result.items){if(p.parent.data_source_id!==id)fail('INVALID_PROVIDER_RESPONSE','Notion returned a page outside its selected data source');available.set(p.id,p);}}
    const saved=[];
    for(const p of available.values()){if(p.archived||p.in_trash)continue;const prior=old.get(p.id);const value=prior&&prior.page.last_edited_time===p.last_edited_time&&Date.now()-Date.parse(prior.checkedAt)<86400000?{...prior,page:p}:{page:p,...await content(p.id),checkedAt:now()};saved.push(value);warnings.push(...value.warnings);}
    return {records:saved.map(v=>record(v.page,v.markdown)),checkpoint:{version:1,pages:saved},strategy:'page-revisions-and-daily-content-reconciliation',coverage:'Selected Notion pages and rows of selected data sources; page markdown and properties, without comments or attachment downloads',warnings:[...new Set(warnings)]};
  },async read(id){
    const p=checked(pageSchema,await http('/pages/'+encodeURIComponent(id)));if(p.id!==id||p.archived||p.in_trash||!allowed(p))fail('RECORD_NOT_FOUND','Notion page is no longer selected or accessible');
    const value=await content(id),r=record(p,value.markdown);if(value.warnings.length)r.warnings=value.warnings;return r;
  }};
}
