import { fail, hash, now, versioned } from "../../domain/identity";
import { type RecordData } from "../../domain/contracts";

// Archives contain assignments to YTD, not executable source. Parse only the JSON RHS.
export function twitterCategory(entry:string) {
  return /(?:^|\/)data\/([a-z0-9_-]+)\.(?:js|json)$/i.exec(entry)?.[1]?.toLowerCase().replace(/(?:-part\d+|_part\d+)$/,"");
}
// Search writing and conversations; retain administrative data only in the original ZIP.
export function twitterSearchableEntry(entry:string) {
  return /^(?:tweets?|community-tweet|twitter-circle-tweet|deleted-tweets?|(?:deleted-)?note-tweet|article|like|direct-messages(?:-group)?|grok-chat-item)$/.test(twitterCategory(entry)||"");
}
export const twitterSearchableTypes=new Set(["twitter-post","twitter-deleted-post","twitter-long-post","twitter-deleted-long-post","twitter-article","twitter-like","twitter-message","twitter-grok-message"]);
export function parseTwitterData(text:string,entry:string):unknown[] {
  const trimmed=text.replace(/^\uFEFF/,"").trim();
  const manifest=twitterCategory(entry)==="manifest";
  const config=manifest ? /^window\.__THAR_CONFIG\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(trimmed) : null;
  const assignment=/^window\.YTD\.[A-Za-z0-9_]+\.part\d+\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(trimmed);
  const json=config ? config[1]! : assignment ? assignment[1]! : trimmed;
  let parsed:unknown;
  try{parsed=JSON.parse(json);}catch{fail("INVALID_ARCHIVE",`Malformed X archive JSON: ${entry}; JavaScript is never executed`);}
  if(manifest && parsed && typeof parsed === "object" && !Array.isArray(parsed))return [parsed];
  if(!Array.isArray(parsed))fail("INVALID_ARCHIVE",`X archive entry must contain an array: ${entry}`);
  if(parsed.length>200_000)fail("SOURCE_LIMIT","X archive entry exceeds the record budget");
  return parsed;
}
type ObjectValue=Record<string,any>;
const object=(value:unknown):ObjectValue=>value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const string=(value:unknown):string|undefined=>typeof value === "string" && value.length ? value : undefined;
function date(value:unknown){
  const text=string(value);
  if(!text || !(/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} [+-]\d{4} \d{4}$/.test(text)))return undefined;
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined;
}
export function twitterRecords(text:string,exportPath:string,entry:string,part:number){
  const category=twitterCategory(entry);if(!category)fail("INVALID_ARCHIVE","Not an X data entry");
  const rows=parseTwitterData(text,entry),records:RecordData[]=[],counts=new Map<string,number>();
  const note=/^(?:deleted-)?note-tweet$/.test(category),article=category==="article",grok=category==="grok-chat-item",encrypted=category==="message-event";
  const post=/^(?:tweets?|community-tweet|twitter-circle-tweet|deleted-tweets?)$/.test(category),dm=/^direct-messages(?:-group)?$/.test(category),like=category==="like";
  const baseType=post ? category.startsWith("deleted-") ? "twitter-deleted-post" : "twitter-post" : note ? category.startsWith("deleted-") ? "twitter-deleted-long-post" : "twitter-long-post" : article ? "twitter-article" : grok ? "twitter-grok-message" : dm ? "twitter-message" : like ? "twitter-like" : "twitter-"+category;
  counts.set(baseType,0);
  function add(raw:unknown,row:number,event?:number,conversation?:string){
    const wrapper=object(raw),key=Object.keys(wrapper),value=object(key.length===1 ? wrapper[key[0]!] : wrapper);
    const created=object(wrapper.messageCreate),isMessage=dm && !!wrapper.messageCreate;
    const data=isMessage ? created : value;
    const id=string(data.id_str) || string(data.id) || string(data.tweetId) || string(data.noteTweetId) || string(data.messageId);
    if(post && (!id || typeof data.full_text!=="string" && typeof data.text!=="string"))fail("INVALID_ARCHIVE",`X post lacks its ID/text: ${entry}, row ${row+1}`);
    if(isMessage && (!id || typeof data.text!=="string"))fail("INVALID_ARCHIVE",`X message lacks its ID/text: ${entry}, row ${row+1}`);
    const type=dm && !isMessage ? "twitter-message-event" : baseType;
    const articleBlocks=article ? object(data.content).blocks : undefined;
    if(note && (!id || typeof object(data.core).text!=="string"))fail("INVALID_ARCHIVE",`X long post lacks its ID/text: ${entry}, row ${row+1}`);
    if(article && (!id || typeof data.title!=="string" || !Array.isArray(articleBlocks) || articleBlocks.some((b:unknown)=>typeof object(b).text!=="string")))fail("INVALID_ARCHIVE",`Malformed X article: ${entry}, row ${row+1}`);
    if(grok && (typeof data.message!=="string" || typeof data.chatId!=="string"))fail("INVALID_ARCHIVE",`Malformed X Grok message: ${entry}, row ${row+1}`);
    const body=post ? data.full_text ?? data.text : note ? object(data.core).text : article ? [data.title,...articleBlocks.map((b:unknown)=>object(b).text)].join("\n\n") : grok ? data.message : isMessage ? data.text : like ? data.fullText : undefined;
    const prose=typeof body==="string" ? body : undefined;
    const sourceDate=data.created_at ?? data.createdAt ?? data.createdAtMsec,occurredAt=encrypted && typeof sourceDate==="string" && /^\d{10,16}$/.test(sourceDate) && Number.isFinite(new Date(Number(sourceDate)).getTime()) ? new Date(Number(sourceDate)).toISOString() : date(sourceDate);
    const grokSender=grok ? string(object(data.sender).name) : undefined;
    const replyTo=string(data.in_reply_to_status_id_str),retweet=post && /^RT @/.test(prose || "");
    const metadata={exportPath,entry,row,event,category,historical:true,nativeId:id,originalRecord:raw,sourceDate,
      ...(grok ? {senderType:grokSender,chatId:data.chatId} : {}),
      ...(encrypted ? {encryptedPayloadAvailable:!!object(object(data.detail).messageCreateEvent).contents,textAvailable:false} : {}),
      dateKind:like ? "unknown-like-time" : occurredAt ? "source-occurrence" : "undated",
      ...(post || like ? {url:id && /^\d+$/.test(id) ? `https://x.com/i/web/status/${id}` : undefined} : {}),
      ...(post || note || article ? {replyTo,reshared:retweet,authorship:retweet ? "reposted-content" : "account-post"} : like ? {authorship:"liked-content"} : {}),
      ...(isMessage ? {senderId:string(data.senderId),recipientId:string(data.recipientId)} : {}),
      bodyStatus:prose ? "text" : "metadata-only"};
    const display=prose ?? JSON.stringify(raw,null,2);
    records.push(versioned({ref:{source:"twitter-archive",id:hash(JSON.stringify([part,entry,row,event]))},
      title:(article ? data.title : prose?.replace(/\s+/g," ").trim() || `${category} ${id || row+1}`).slice(0,200),body:display,
      sections:[{kind:prose===undefined ? "metadata" : grok && grokSender!=="User" ? "generated" : retweet || like ? "quoted" : "primary",start:0,end:display.length}],type,
      locator:exportPath+"#"+encodeURIComponent(entry)+"/row/"+(row+1)+(event===undefined ? "" : "/event/"+(event+1)),
      author:isMessage || encrypted ? string(data.senderId) : grok ? grokSender : undefined,conversation:dm ? conversation : grok ? "grok:"+data.chatId : encrypted ? string(data.conversationId) : undefined,occurredAt,observedAt:now(),metadata,
      warnings:[...(sourceDate && !occurredAt ? ["Unsupported source date retained verbatim; omitted from date-filtered results."] : []),...(retweet || like ? ["This is someone else's content retained as a repost/like; it does not establish account authorship."] : []),...(encrypted ? ["New X Chat events retain metadata and encrypted payloads, not readable message text; ciphertext is not treated as prose."] : prose===undefined ? ["No supported prose projection; use sections:[metadata] to search this original JSON record."] : [])]}));
    counts.set(type,(counts.get(type)||0)+1);
    if(records.length>200_000)fail("SOURCE_LIMIT","X entry exceeds the record budget");
  }
  rows.forEach((row,index)=>{
    if(!row || typeof row!=="object" || Array.isArray(row))fail("INVALID_ARCHIVE",`X archive row must be an object: ${entry}`);
    if(dm){
      const conversation=object(object(row).dmConversation);
      if(!Array.isArray(conversation.messages) || typeof conversation.conversationId!=="string")fail("INVALID_ARCHIVE",`Malformed X DM conversation: ${entry}`);
      conversation.messages.forEach((event:unknown,i:number)=>add(event,index,i,conversation.conversationId));
    }else add(row,index);
  });
  return {records,categories:[...counts].map(([recordType,records])=>({entry,records,recordType}))};
}
export function twitterContext(record:RecordData,all:RecordData[]){
  if(!record.conversation)return {records:[],warnings:["No exported DM conversation on this record. Post reply IDs remain in details; no missing thread text is invented."]};
  const ordered=all.filter(r=>r.conversation===record.conversation).sort((a,b)=>(a.occurredAt || "\uffff").localeCompare(b.occurredAt || "\uffff") || String(a.metadata?.entry).localeCompare(String(b.metadata?.entry)) || Number(a.metadata?.row)-Number(b.metadata?.row) || Number(a.metadata?.event)-Number(b.metadata?.event));
  const at=ordered.findIndex(r=>r.ref.id===record.ref.id);
  return {records:ordered.slice(Math.max(0,at-5),at+6).filter(r=>r.ref.id!==record.ref.id).map(r=>({ref:r.ref,title:r.title,type:r.type,author:r.author,occurredAt:r.occurredAt,excerpt:r.metadata?.encryptedPayloadAvailable ? "Encrypted X Chat event; readable message text is not present in the export." : r.body.slice(0,500)})),warnings:["Conversation context includes up to five exported events on each side. Sender IDs are preserved; names are not inferred."]};
}

export function twitterCatalogue(categories:{entry:string;records:number;recordType:string}[]) {
  const counts=new Map<string,number>();
  for(const c of categories)counts.set(c.recordType,(counts.get(c.recordType)||0)+c.records);
  return {categories:[...counts].filter(([,n])=>n>0).map(([recordType,records])=>({recordType,records})),emptyRecordTypes:[...counts].filter(([,n])=>n===0).map(([type])=>type),categoryEntries:categories.length,categoryDetails:"Counts are grouped by record type. Exact entry names are retained on original record reads."};
}
