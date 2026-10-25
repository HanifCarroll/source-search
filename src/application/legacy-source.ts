import {bindFocus} from '../domain/content';
import {cursor,position} from '../domain/identity';
import type {Page,Query,RecordData,Ref} from '../domain/contracts';
import type {PreviewBudget} from '../sources/mail';
import {z} from 'zod';

export type ReadResult={record:RecordData;context?:unknown[];contextWarnings?:string[]};
export type SourceAdapter={
  status():Promise<Record<string,unknown>>;
  search(query:Query,previews:PreviewBudget):Promise<Page>;
  read(ref:Ref,context:boolean):Promise<ReadResult>;
};
const contextRecord=z.object({ref:z.object({source:z.string(),id:z.string()}).passthrough(),locator:z.string().optional()}).passthrough();

// Old adapters store canonical names in their references and cursors. Keep that
// wire format at this explicit seam, without rebuilding the entire reader tree
// or rewriting arbitrary source fields inside a record's original metadata.
export function legacySource(id:string,kind:string,key:string,adapter:SourceAdapter):SourceAdapter {
  if(id===kind)return adapter;
  const token=(value:string)=>cursor(key,value);
  function record<T extends {ref:Ref;locator?:string}>(value:T):T {
    return {...value,adapter:kind,ref:{...value.ref,source:id},
      ...(value.locator?{locator:value.locator.replace('source-search://'+kind+'/','source-search://'+id+'/')}:{}),
    };
  }
  return {
    status:()=>adapter.status(),
    async search(query,previews) {
      const page=await adapter.search({...query,source:kind,cursor:query.cursor?String(position(query.cursor,key)):undefined},previews);
      return {...page,source:id,nextCursor:page.nextCursor?token(page.nextCursor):undefined,
        items:page.items.map(item=>({...record(item),cursorAfter:token(item.cursorAfter),...(item.focus?{focus:bindFocus(item.focus,id,kind)}:{})})),
      };
    },
    async read(ref,context) {
      const result=await adapter.read({...ref,source:kind},context);
      return {...result,record:record(result.record),context:result.context?.map(value=>{
        const parsed=contextRecord.safeParse(value);
        return parsed.success&&parsed.data.ref.source===kind ? record(parsed.data) : value;
      })};
    },
  };
}
