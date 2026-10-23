import {z} from 'zod';
import {collectChatGptAttachments} from '../../vendor/chatgpt/parser';
import { hash, now, versioned, fail } from "../../domain/identity";
import { type RecordData } from "../../domain/contracts";
const timestamp=z.string().regex(/(?:Z|[+-]\d{2}:\d{2})$/).refine(s=>Number.isFinite(Date.parse(s)),'Invalid group message date');
const groupSchema=z.object({chats:z.array(z.object({id:z.string().min(1),name:z.string().optional().nullable(),messages:z.array(z.object({id:z.string().min(1),role:z.string().min(1),text:z.string().optional().nullable(),created_at:timestamp,attachments:z.array(z.unknown()).optional()}).passthrough())}).passthrough())});
export function chatGptGroups(input:unknown,path:string,entry:string,part:number){
 const groups=groupSchema.parse(input),records:RecordData[]=[];
 for(const group of groups.chats)for(const m of group.messages){
  if(records.length>=200_000)fail('SOURCE_LIMIT','ChatGPT groups exceed the record budget');
  const attachments=collectChatGptAttachments(m,{shardPath:entry,sourceAccountId:'selected-export'});
  records.push(versioned({ref:{source:'chatgpt-archive',id:hash(JSON.stringify([part,'group',group.id,m.id]))},title:group.name || 'ChatGPT group conversation',body:m.text || '',type:'chatgpt-group-message',author:m.role,conversation:group.id,occurredAt:new Date(m.created_at).toISOString(),observedAt:now(),locator:path+'#'+entry+'/'+encodeURIComponent(group.id)+'/'+encodeURIComponent(m.id),metadata:{exportPath:path,shard:entry,conversationId:group.id,messageId:m.id,group:true,contentType:attachments.length ? 'multimodal_text' : 'text',attachments,textAvailable:!!m.text,sourceTimestamp:m.created_at,dateKind:'group-message',senderIdentity:'not-exported'},warnings:[...(!m.text ? ['This group message has no exported text; media bytes are not searched.'] : []),...(attachments.length ? ['Attachment pointers are retained; attachment bytes are not searched.'] : [])]}));
 }
 return {records,conversations:{total:groups.chats.length,withMessages:groups.chats.filter(g=>g.messages.length).length,empty:groups.chats.filter(g=>!g.messages.length).length}};
}
