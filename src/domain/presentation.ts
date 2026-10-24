import {sourceKind,isMail} from './source-catalog';
import { readableHtml } from "../formats/html";
import { hash } from "./identity";
import { type RecordData, type Page, type Query } from "./contracts";
import { searchableText, words } from "./query";
import { isAbsolute } from "node:path";
export function readableMail(text: string) {
    return /^\s*(?:<!doctype\s+html|<(?:html|body|div|table|p|span|head|b|a|ul|li|br|h[1-6])\b)/i.test(text) ? readableHtml(text) : text;
}
export function excerpt(body: string, query: string) {
    const text = searchableText(body), term = words(query)[0];
    const index = term ? text.toLocaleLowerCase().indexOf(term) : 0;
    return text.slice(Math.max(0, index - 100), Math.max(0, index - 100) + 500);
}
export function recordLink(r: RecordData) {
    const m = r.metadata, source=r.adapter || sourceKind(r.ref.source);
    if(source === "chrome-downloads")
      return typeof m?.openLink === "string" ? m.openLink : undefined;
    if(source === "chatgpt-archive" && !m?.group && r.conversation && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.conversation))return `https://chatgpt.com/c/${r.conversation}`;
    if (source === "gmail")
        return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(String(m?.account || ""))}#all/${r.conversation || r.ref.id}`;
    if (source === "fastmail") {
        const names: Record<string,string> = {inbox:"Inbox",archive:"Archive",trash:"Trash",junk:"Spam",sent:"Sent",drafts:"Drafts"};
        const folder = (m?.folders as {role?:string}[] | undefined)?.find(f => f.role && names[f.role]);
        // shortcut: only native role folders have verified web paths; custom-only mail retains its record reference.
        if(folder?.role && r.conversation) {
            const name = names[folder.role], query = `in:${name.toLowerCase()} subject:"${r.title.replaceAll('"','')}"`;
            return `https://app.fastmail.com/mail/${name}/search:${encodeURIComponent(query)}/${encodeURIComponent(r.conversation)}.${encodeURIComponent(r.ref.id)}`;
        }
        return undefined;
    }
    const headers = m?.headers as Record<string, string[]> | undefined;
    const thread = headers?.["x-gm-thrid"]?.[0];
    if (r.type === "email" && thread && /^\d+$/.test(thread))
        return `https://mail.google.com/mail/u/?#all/${BigInt(thread).toString(16)}`;
    if (typeof m?.url === "string" && /^https?:\/\//.test(m.url))
        return m.url;
    if(source === "linkedin-archive" || source === "twitter-archive")return undefined;
    if (!r.locator.startsWith("source-search://"))
        return r.locator.split("#")[0];
    return undefined;
}
export function compactRecord(r: RecordData, details = false): RecordData {
    const m = { ...r.metadata }, source=r.adapter || sourceKind(r.ref.source);
    const originalRecord=m.originalRecord;
    const headers = m.headers as Record<string, string[]> | undefined;
    if (headers?.["message-id"]?.[0])
        m.messageId = headers["message-id"][0];
    const link = recordLink(r);
    if (link)
        m.openLink = link;
    else if(source==="linkedin-archive" || source==="twitter-archive")m.openAction="read_record with preview:true";
    m.dateKind = m.dateKind || (r.type === "email" ? "message-timestamp-unknown-basis" : r.type === "written-journal" || r.type.includes("transcript") && r.metadata?.datePrecision === "day" ? "journal-day" : "source-occurrence");
    if (!details) {
        delete m.headers;
        delete m.archiveSha256;
        delete m.nativeId;
        delete m.originalContent;
        delete m.originalFields;
        delete m.originalRecord;
        if(source === "chrome-downloads")delete m.url;
    }
    const twitterOriginal=source === "twitter-archive" ? originalRecord : undefined;
    if(source === "twitter-archive")delete m.originalRecord;
    const related=googleDocument(m.url);if(related)m.relatedResource=related;
    const date = r.occurredAt;
    return { ...r, ...(details && twitterOriginal!==undefined && m.bodyStatus!=="metadata-only" ? {body:r.body+"\n\nOriginal export record\n"+JSON.stringify(twitterOriginal,null,2)} : {}), ...(!details && source === "takeout-archive" ? { body: r.body.split("\n\nOriginal export record\n")[0] } : {}), ...(date && Number.isFinite(Date.parse(date)) ? { occurredAt: new Date(date).toISOString() } : {}), metadata: m };
}
type Evidence=Pick<RecordData,"adapter"|"ref"|"title"|"author"|"occurredAt"|"type"|"metadata">;
export function duplicateKey(r: Evidence, preferMessageId = true) {
    const messageId = r.metadata?.messageId || (r.metadata?.headers as any)?.["message-id"]?.[0];
    if (r.type === "email" && messageId && preferMessageId)
        return hash(`email:${messageId}`);
    if (r.type === "email" && "author" in r && "occurredAt" in r && "title" in r && r.author && r.occurredAt) {
        const address = String(r.author).match(/<([^>]+)>/)?.[1] || String(r.author);
        return hash(`possible-email:${String(r.title).trim().toLowerCase()}:${address.toLowerCase()}:${String(r.occurredAt).slice(0, 16)}`);
    }
    const meeting = (r.adapter || sourceKind(r.ref.source)) === "muesli" ? r.ref.id : r.metadata?.muesliMeetingId || String(r.metadata?.sourceLocator || "").match(/^Muesli meetings\.id=(\d+);/)?.[1];
    if(meeting)return hash("muesli:"+((r.adapter || sourceKind(r.ref.source)) === "muesli" ? r.ref.source : "calls")+":"+meeting);
    if((r.adapter || sourceKind(r.ref.source)) === "chrome-history" && typeof r.metadata?.url === "string"){
      const doc=googleDocument(r.metadata.url);if(doc)return hash("google-resource:"+doc.url);
    }
    return undefined;
}
function originalFileKey(r: Evidence) {
    if(["vault","markdown"].includes(r.adapter || sourceKind(r.ref.source)) && typeof r.metadata?.openLink === "string" && isAbsolute(r.metadata.openLink))return hash("original-file:"+r.metadata.openLink);
    return undefined;
}
export function annotateDuplicates(items: Evidence[]) {
    const groups = new Map<string,Set<typeof items[number]>>();
    for(const item of items) {
        if(item.metadata) delete item.metadata.duplicateEvidence;
        for(const key of [duplicateKey(item),duplicateKey(item,false),originalFileKey(item)]) if(key) {
            const group = groups.get(key) || new Set(); group.add(item); groups.set(key,group);
        }
    }
    for(const group of groups.values()) for(const item of group) for(const other of group) {
        if(item===other) continue;
        const a=item.metadata?.messageId,b=other.metadata?.messageId;
        if(a && b && a!==b) continue;
        const duplicates=(item.metadata?.duplicateEvidence || []) as {ref:RecordData["ref"];reason:string}[];
        if(!duplicates.some(d=>d.ref.source===other.ref.source && d.ref.id===other.ref.id))duplicates.push({ref:other.ref,reason:((item.adapter || sourceKind(item.ref.source)) === "vault" || (other.adapter || sourceKind(other.ref.source)) === "vault") && item.metadata?.openLink===other.metadata?.openLink ? "same original Markdown file; QMD and native reader are one evidence lineage" : (item.adapter || sourceKind(item.ref.source)) === "muesli" || (other.adapter || sourceKind(other.ref.source)) === "muesli" ? "same Muesli meeting; retained note and original transcript are related representations" : (item.adapter || sourceKind(item.ref.source)) === "chrome-history" && (other.adapter || sourceKind(other.ref.source)) === "chrome-history" ? "same Google resource; distinct visits or heading links" : a && b ? "same original Message-ID" : "possible duplicate: same subject, sender and minute; verify originals"});
        item.metadata={...item.metadata,duplicateEvidence:duplicates};
    }
}
export function progress(page: Page, q: Query, adapter=sourceKind(q.source)) {
    page.progress = { returned: page.items.length, hasMore: !!page.nextCursor, totalMatches: page.totalMatches ?? null, ...(page.scan ? {candidatesChecked:page.scan.checked,undecodable:page.scan.undecodable,...(page.scan.missingText ? {missingText:page.scan.missingText} : {}),exhausted:page.scan.exhausted,...(page.scan.workLimit ? {workLimit:page.scan.workLimit} : {})} : {}),continuation: page.nextCursor ? page.items.length ? "more-results-or-candidates" : "more-candidates-to-check" : page.scan?.exhausted===false ? "incomplete-source" : (q.source === "vault" || q.source === "library" || q.source === "documents" || !!page.retrieval) ? "ranked-candidates-exhausted" : "complete" };
    page.query = { ...page.query, text: q.query, ...(q.mode || (["agent-history","vault","library","documents"].includes(adapter) || !!page.retrieval) ? {mode:q.mode || "hybrid"} : {}), match: page.query?.match || q.match || (isMail(adapter) || (["agent-history","vault","library","documents"].includes(adapter) || !!page.retrieval) ? "provider-native" : "word-prefix"), sort: page.query?.sort || q.sort || ((["agent-history","vault","library","documents"].includes(adapter) || !!page.retrieval) ? "relevance" : ["contacts","vcard"].includes(adapter) ? "source-order" : "newest"), from: q.from, to: q.to, task:q.task, types: q.types, sections:q.sections, roles:q.roles,contentTypes:q.contentTypes,selectedBranch:q.selectedBranch, folders: q.folders,...(isMail(adapter) || adapter === "takeout-archive" ? {excludeSpamTrash:q.excludeSpamTrash!==false} : {}) };
    return page;
}

export function googleDocument(value:unknown) {
  if(typeof value!=="string")return undefined;
  try{const u=new URL(value),doc=u.hostname === "docs.google.com" ? /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/.exec(u.pathname)?.[1] : undefined,folder=u.hostname === "drive.google.com" ? /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,200})(?:\/|$)/.exec(u.pathname)?.[1] : undefined;
    if(u.protocol!=="https:" || u.port || u.username || u.password || !(doc || folder))return undefined;
    return {kind:doc?"google-doc":"google-drive-folder",url:doc?`https://docs.google.com/document/d/${doc}/edit`:`https://drive.google.com/drive/folders/${folder}`,contentFetched:false,reader:"Connected Google Drive fetch",instruction:"Read this exact resource through the connected Google Drive reader when relevant; browser visits are metadata, not its contents."};
  }catch{return undefined;}
}
