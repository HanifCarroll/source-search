import {sourceKind,isMail,sourceDefinition,type SourceCatalog} from './source-catalog';
import { isProjected, usesLibrary } from "./source-policy";
import { fail } from "./identity";
import { type Query, type RecordData } from "./contracts";
export const wordPattern=/(?<![\p{L}\p{N}])\.[\p{L}][\p{L}\p{N}]*|[\p{L}\p{N}]+(?:\+\+|#)?/gu;
export function words(text: string) { return text.normalize("NFKC").toLocaleLowerCase().match(wordPattern) || []; }
export function searchableText(body: string) { return body.split("\n\nOriginal export record\n")[0].replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""); }
export function matchesQuery(text: string, q: Pick<Query, "query" | "match">) {
    const body = text;
    if (q.match === "phrase")
        return body.normalize("NFKC").toLocaleLowerCase().includes(q.query.normalize("NFKC").toLocaleLowerCase());
    const tokens = words(body);
    return words(q.query).every(t => tokens.some(word => word.startsWith(t)));
}
export function filterRecord(record: RecordData, q: Query) { return !q.types?.length || q.types.includes(record.type); }
export function sortRecords(records: RecordData[], q: Query) {
    if (!q.sort)
        return records;
    return [...records].sort((a, b) => {
        if(q.sort==='due')return (!a.task?.dueDate||!b.task?.dueDate ? Number(!a.task?.dueDate)-Number(!b.task?.dueDate) : a.task.dueDate.localeCompare(b.task.dueDate)) || a.ref.id.localeCompare(b.ref.id);
        if (q.sort === "relevance")
            return words(q.query).reduce((n, w) => n + Number(words(b.title).some(t => t.startsWith(w))) - Number(words(a.title).some(t => t.startsWith(w))), 0) || a.ref.id.localeCompare(b.ref.id);
        if (!a.occurredAt || !b.occurredAt)
            return Number(!a.occurredAt) - Number(!b.occurredAt) || a.ref.id.localeCompare(b.ref.id);
        return (Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) * (q.sort === "oldest" ? 1 : -1) || a.ref.id.localeCompare(b.ref.id);
    });
}
export function validateOptions(q: Query,catalog:SourceCatalog={}) {
    const source = sourceKind(q.source,catalog), mail=isMail(q.source,catalog), definition=sourceDefinition(q.source,catalog);
    if((q.task||q.sort==='due')&&!definition?.filters.includes('task'))fail('UNSUPPORTED_FILTER','Task filters and due sorting require a task source');
    if(definition?.filters.includes('task')&&q.conversation)fail('UNSUPPORTED_FILTER','Tasks have no conversation filter');
    if(usesLibrary(q,catalog)){
        if(q.task || q.from || q.to || q.conversation || q.match || q.sections || q.types || q.roles || q.contentTypes || q.selectedBranch!==undefined || q.folders || q.excludeSpamTrash!==undefined || q.sort && q.sort!=="relevance")fail("UNSUPPORTED_FILTER","Hybrid library discovery supports mode and relevance only; use the native source without mode for exact filters");
        if(mail && /(?:^|\s)(?:from|to|in|label|has|after|before|newer_than):/.test(q.query))fail("UNSUPPORTED_FILTER","Use native mail search without mode for Gmail query operators");
        return;
    }
    if(q.mode && !definition?.ranked && !isProjected(q.source,catalog))fail("UNSUPPORTED_FILTER","Search mode is unavailable for this source");
    if(source === "vault" && (q.from || q.to || q.conversation || q.match || q.sections || q.types || (q.sort && q.sort!=="relevance")))fail("UNSUPPORTED_FILTER","QMD supports relevance ordering and mode only; use the original source readers for date/section filters");
    if(q.sections && (mail || source === "agent-history"))fail("UNSUPPORTED_FILTER","Provider-native searches cannot filter text sections; read the record and inspect its match/section instead");
    if(source !== "chatgpt-archive" && (q.roles !== undefined || q.contentTypes !== undefined || q.selectedBranch !== undefined))fail("UNSUPPORTED_FILTER","Role, contentTypes and selectedBranch filters are available only for the ChatGPT export");
    if (q.types?.length && !definition?.filters.includes('types'))
        fail("UNSUPPORTED_FILTER", `${source} has one record family; omit types. Use list_sources for supported filters.`);
    if (q.folders?.length && !mail)
        fail("UNSUPPORTED_FILTER", "Folder filters are available only for live mail sources");
    if(q.excludeSpamTrash !== undefined && !mail && source!=="takeout-archive")
        fail("UNSUPPORTED_FILTER", "Spam/trash exclusion is available only for live mail and Takeout email");
    if(["contacts","vcard"].includes(source) && q.sort && q.sort !== "relevance")
        fail("UNSUPPORTED_SORT", "Contacts have no occurrence date; use relevance or omit sort");
    if (q.match && source === "agent-history")
        fail("UNSUPPORTED_FILTER", "Agent history uses CASS native search syntax; omit match");
    if (q.sort === "relevance" && !definition?.sort.includes('relevance'))
        fail("UNSUPPORTED_SORT", `${source} supports newest/oldest, not relevance ranking`);
    if (source === "agent-history" && q.sort && q.sort !== "relevance")
        fail("UNSUPPORTED_SORT", "CASS uses native relevance ordering");
    if ((source === "gmail") && q.sort === "oldest")
        fail("UNSUPPORTED_SORT", "Gmail API orders newest first; use date windows to retrieve older mail");
}
