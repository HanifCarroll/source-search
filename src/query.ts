import { fail, type Query, type RecordData } from "./shared";
export const groups = {
    "all-journals": ["journals", "voice-journals"],
    "all-mail": ["mail-personal", "mail-consulting", "mail-fastmail"],
    "historical-exports": ["things-archive", "chatgpt-archive", "takeout-archive", "linkedin-archive", "twitter-archive"],
} as const;
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
        if (q.sort === "relevance")
            return words(q.query).reduce((n, w) => n + Number(words(b.title).some(t => t.startsWith(w))) - Number(words(a.title).some(t => t.startsWith(w))), 0) || a.ref.id.localeCompare(b.ref.id);
        if (!a.occurredAt || !b.occurredAt)
            return Number(!a.occurredAt) - Number(!b.occurredAt) || a.ref.id.localeCompare(b.ref.id);
        return (Date.parse(a.occurredAt) - Date.parse(b.occurredAt)) * (q.sort === "oldest" ? 1 : -1) || a.ref.id.localeCompare(b.ref.id);
    });
}
export function validateOptions(q: Query) {
    const source = q.source;
    const projected=["library","documents","things-archive","chatgpt-archive","takeout-archive","linkedin-archive","twitter-archive","messages","whatsapp","calls","mail-personal","mail-consulting","mail-fastmail"];
    if(source==="library" || source==="documents" || q.mode && q.mode!=="lexical" && projected.includes(source)){
        if(q.from || q.to || q.conversation || q.match || q.sections || q.types || q.roles || q.contentTypes || q.selectedBranch!==undefined || q.folders || q.excludeSpamTrash!==undefined || q.sort && q.sort!=="relevance")fail("UNSUPPORTED_FILTER","Hybrid library discovery supports mode and relevance only; use the native source without mode for exact filters");
        if(source.startsWith("mail-") && /(?:^|\s)(?:from|to|in|label|has|after|before|newer_than):/.test(q.query))fail("UNSUPPORTED_FILTER","Use native mail search without mode for Gmail query operators");
        return;
    }
    if(q.mode && !["agent-history","vault",...projected].includes(source))fail("UNSUPPORTED_FILTER","Search mode is unavailable for this source");
    if(source === "vault" && (q.from || q.to || q.conversation || q.match || q.sections || q.types || (q.sort && q.sort!=="relevance")))fail("UNSUPPORTED_FILTER","QMD supports relevance ordering and mode only; use the original source readers for date/section filters");
    if(q.sections && (source.startsWith("mail-") || source === "agent-history"))fail("UNSUPPORTED_FILTER","Provider-native searches cannot filter text sections; read the record and inspect its match/section instead");
    if(source !== "chatgpt-archive" && (q.roles !== undefined || q.contentTypes !== undefined || q.selectedBranch !== undefined))fail("UNSUPPORTED_FILTER","Role, contentTypes and selectedBranch filters are available only for the ChatGPT export");
    if (q.types?.length && source !== "takeout-archive" && source !== "things-archive" && source !== "chatgpt-archive" && source !== "linkedin-archive" && source !== "twitter-archive")
        fail("UNSUPPORTED_FILTER", `${source} has one record family; omit types. Use list_sources for supported filters.`);
    if (q.folders?.length && !source.startsWith("mail-"))
        fail("UNSUPPORTED_FILTER", "Folder filters are available only for live mail sources");
    if(q.excludeSpamTrash !== undefined && !source.startsWith("mail-") && source!=="takeout-archive")
        fail("UNSUPPORTED_FILTER", "Spam/trash exclusion is available only for live mail and Takeout email");
    if(source === "contacts" && q.sort && q.sort !== "relevance")
        fail("UNSUPPORTED_SORT", "Contacts have no occurrence date; use relevance or omit sort");
    if (q.match && source === "agent-history")
        fail("UNSUPPORTED_FILTER", "Agent history uses CASS native search syntax; omit match");
    if (q.sort === "relevance" && !["journals", "voice-journals", "call-notes", "things-archive", "takeout-archive", "chatgpt-archive", "linkedin-archive", "twitter-archive", "calendar", "contacts", "chrome-bookmarks", "agent-history", "vault"].includes(source))
        fail("UNSUPPORTED_SORT", `${source} supports newest/oldest, not relevance ranking`);
    if (source === "agent-history" && q.sort && q.sort !== "relevance")
        fail("UNSUPPORTED_SORT", "CASS uses native relevance ordering");
    if ((source === "mail-personal" || source === "mail-consulting") && q.sort === "oldest")
        fail("UNSUPPORTED_SORT", "Gmail API orders newest first; use date windows to retrieve older mail");
}
