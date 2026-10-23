import { libraryStatus, searchLibrary, readLibrary, readDocument } from "./library";
import { writePreview } from "./preview";
import { describeSource, groups } from "./catalogue";
import { querySchema } from "./shared";
import { validateOptions } from "./query";
import { compactRecord, annotateDuplicates, progress } from "./presentation";
import { sourceEnabled, requireSource, type Config } from "./config";
import { sourceIds, searchSchema, readSchema, textPage, assertPacket, assertVersion, packetBytes, errorData, now, type Page } from "./shared";
import { journalPaths, searchJournals, journalRecord, thingsRecords } from "./local";
import { searchArchive, indexStatus } from "./archive";
import { searchMessages, readMessage, messagesStatus } from "./messages";
import { searchMail, readMail, mailContext, type MailSource, run, type Run, type PreviewBudget } from "./mail";

import { archiveSignature, checkExportSelection, readExport, exportPaths, exportProjectionVersion, chatGptContext, linkedInContext, twitterArchiveContext } from "./exports";
import { databaseStatus, searchDatabase, readDatabase } from "./local-databases";
import { notesStatus, searchNotes, readNote } from "./files";
import { pimStatus, searchPim, readPim } from "./pim";
import { chromeStatus, searchChrome, readChrome } from "./chrome";
import { qmdStatus, searchQmd, readQmd } from "./qmd";
import { cassStatus, searchCass, readCass } from "./cass";

export function createRuntime(config: Config, execute: Run = run) {
  const mailExecute: Run = argv => execute([argv[0]!.endsWith("/.local/bin/gog") ? config.gmailBinary : argv[0]!, ...argv.slice(1)]);
  async function list_sources() {
    const previews:PreviewBudget={remaining:0,records:new Map()};
    const sources = await boundedMap(sourceIds, async source => {
      const base = { source, readOnly: true, checkedAt: now() };
      if(!sourceEnabled(config,source))return {...base,available:false,state:"disabled",error:{code:"SOURCE_DISABLED",message:"Enable this source in local configuration"}};
      try {
        if(source === "library")return {...base,...await libraryStatus(config)};
        if(source === "documents"){const status=await libraryStatus(config),doc=status.sources?.find(s=>s.source==="documents");return {...base,...doc,available:(doc?.embeddings?.indexedDocuments||0)>0,modelsPresent:status.modelsPresent};}
        if (source.startsWith("mail-")) {
          const id = source as MailSource;
          const result = await searchMail({ source, query: source === "mail-fastmail" ? "" : "newer_than:1d", limit: 1 }, mailExecute, previews, config);
          return { ...base, available: true, account: config.mailAccounts[id]!.email, aliases: config.mailAccounts[id]!.aliases,
            querySyntax: source === "mail-fastmail" ? "provider text" : "Gmail query syntax", filters: ["from", "to", "folders", "excludeSpamTrash"], pagination: true, coverage: "Provider mailbox; full historical coverage has not been established", warnings: result.warnings };
        }
        if (source === "messages") return { ...base, available: true, ...(await messagesStatus(config)), filters: ["from", "to", "conversation"], querySyntax: "literal words, all must match", coverage: "Local Mac store; bounded candidate scan with continuation" };
        if (source === "journals") { const paths = await journalPaths(config.journals); return { ...base, available: true, dailyNotes: paths.paths.length, filters: ["from", "to"], querySyntax: "literal words, all must match", coverage: "Daily written journals; voice and call transcripts have separate source IDs", warnings: paths.warnings }; }
        if (source === "whatsapp" || source === "calls") return { ...base, available: true, ...await databaseStatus(config, source), filters: ["from", "to", ...(source === "whatsapp" ? ["conversation"] : [])], querySyntax: "literal words, all must match", pagination: true };
        if (source === "voice-journals" || source === "call-notes") return { ...base, available: true, ...await notesStatus(config, source), filters: ["from", "to"], querySyntax: "literal words, all must match", pagination: true };
        if (source === "calendar" || source === "contacts") return { ...base, available: true, ...await pimStatus(config, source), filters: source === "calendar" ? ["from and to required; bounded window continuation"] : [], querySyntax: "literal words, all must match", pagination: true };
        if (source.startsWith("chrome-")) return { ...base, available: true, ...await chromeStatus(config, source), filters: ["from", "to"], querySyntax: "literal words, all must match", pagination: true };
        if (source === "vault") return { ...base, ...await qmdStatus(config), pagination: true };
        if (source === "agent-history") return { ...base, ...await cassStatus(config), pagination: true };
        if (source === "chatgpt-archive" || source === "takeout-archive" || source === "linkedin-archive" || source === "twitter-archive") {
          const selected = exportPaths(config,source);
          if (!selected.length) return { ...base, available: false, error: { code: "SOURCE_NOT_CONFIGURED", message: "Fresh export not yet downloaded and selected" } };
          await checkExportSelection(config, source);
          const state = await indexStatus(config), index = state[source] ? JSON.parse(state[source]) : null;
          if(index)index.stale=(exportProjectionVersion(source)>1 && index.projectionVersion!==exportProjectionVersion(source)) || !!index.signature && index.signature!==await archiveSignature(config,source);
          return { ...base, available: !!index, index, selectedExports: selected, coverage: "Selected original export snapshot; edits appear after explicit rebuild", filters: ["from", "to", ...(source === "chatgpt-archive" || source === "linkedin-archive" || source === "twitter-archive" ? ["conversation"] : [])], querySyntax: "literal full-text terms, all must match", pagination: true };
        }
        const originals = await thingsRecords(config);
        let index: unknown; try { const state = await indexStatus(config); index = { ...JSON.parse(state["things-archive"] || "{}"), indexedAt:state.indexedAt, stale: state.generation !== originals.generation }; } catch (e) { index = { available: false, error: errorData(e), action: "Run source-search rebuild" }; }
        return { ...base, available: true, taskCount: originals.info.taskCount, dateRange: originals.info.createdDateRange, snapshotAt: originals.info.exportedAt, editedAt: originals.info.archiveEditedAt, index, filters: ["from", "to"], querySyntax: "literal full-text terms, all must match", coverage: "Edited historical archive; date filters use task creation time" };
      } catch (e) { return { ...base, available: false, error: errorData(e) }; }
    });
    const described=sources.map(s=>describeSource(config,s));
    const result = {sources:described,groups,summary:{ready:described.filter(s=>s.state === "ready").length,total:described.length},connection:{codeReload:"Automatic on the next request after installing the updated MCP gateway",initialRefresh:"Connections started before this gateway update require a one-time reconnect"}}; assertPacket(result); return result;
  }
  async function search_sources(input: unknown) {
    const previews:PreviewBudget={remaining:3,records:new Map()};
    const selection=searchSchema.parse(input);
    const queries=selection.queries.flatMap(q=>q.source in groups ? groups[q.source as keyof typeof groups].map(source=>querySchema.parse({...q,source})) : [querySchema.parse(q)]);
    if(new Set(queries.map(q=>q.source)).size!==queries.length)throw Error("Source selections overlap; choose each source once");
    async function fetchPage(q:ReturnType<typeof querySchema.parse>):Promise<Page> {
      try {
        requireSource(config,q.source);
        validateOptions(q);
        const result = q.source === "library" || q.source === "documents" || q.mode && q.mode!=="lexical" && !["vault","agent-history"].includes(q.source) ? await searchLibrary(config,q)
          : q.source === "whatsapp" || q.source === "calls" ? await searchDatabase(config, q)
          : q.source === "voice-journals" || q.source === "call-notes" ? await searchNotes(config, q)
          : q.source === "calendar" || q.source === "contacts" ? await searchPim(config, q)
          : q.source.startsWith("chrome-") ? await searchChrome(config, q)
          : q.source === "vault" ? await searchQmd(config, q)
          : q.source === "agent-history" ? await searchCass(config, q)
          : q.source.startsWith("mail-") ? await searchMail(q, mailExecute, previews, config) : q.source === "messages" ? await searchMessages(config, q) : q.source === "journals" ? await searchJournals(config, q) : await searchArchive(config, q);
        progress(result,q);
        if(result.status!=="error" && !result.items.length){
          if(result.nextCursor)result.warnings.push("No matches in this batch; continue before concluding that nothing matches.");
          else if(result.scan?.missingText && result.scan.missingText===result.scan.checked)result.warnings.push("No checked entries have readable text. Different keywords cannot recover it; inspect the original application or obtain more complete history.");
          else if(!result.warnings.length)result.warnings.push("No matches for this query in this source scope. Try a shorter word prefix, different terms or a wider date window.");
        }
        assertPacket(result); return result;
      } catch (e) {
        if(errorData(e).code === "OUTPUT_LIMIT" && q.limit>1){const page=await fetchPage({...q,limit:Math.max(1,Math.floor(q.limit/2))});page.budgetReduced=true;page.reduction={requested:q.limit,returned:page.items.length,reason:"Provider page exceeded the output budget"};return page;}
        return { source: q.source, status: "error", items: [], error: errorData(e), warnings: [], observedAt: now() };
      }
    }
    const results=await boundedMap(queries,fetchPage);
    // Preserve a continuation for removed hits instead of silently skipping a page when trimming.
    const output = { results, truncated: results.some(p=>p.budgetReduced) };
    while (true) {
      annotateDuplicates(results.flatMap(r=>r.items));
      if(packetBytes(output) <= 42 * 1024)break;
      const result = results.filter(r => r.items.length > 1).sort((a, b) => b.items.length - a.items.length)[0];
      if (!result) {
        const largest=results.filter(r=>r.status!=="error").sort((a,b)=>JSON.stringify(b).length-JSON.stringify(a).length)[0];
        if(!largest)break;
        results[results.indexOf(largest)]={source:largest.source,status:"error",items:[],warnings:[],error:{code:"OUTPUT_LIMIT",message:"One result cannot fit the shared output budget; search this source separately"},observedAt:now()};output.truncated=true;continue;
      }
      result.items.pop(); result.budgetReduced = true; output.truncated = true;
      if (result.source === "mail-personal" || result.source === "mail-consulting" || result.source === "agent-history") {
        // shortcut: Gmail/CASS have no safe intra-page token here; retry smaller pages until their providers expose one.
        const index=results.indexOf(result), q=queries[index];
        results[index]=await fetchPage({...q,limit:Math.max(1,Math.floor(result.items.length/2))});
        results[index].budgetReduced=true;
      } else result.nextCursor = result.items.at(-1)!.cursorAfter;
    }
    for(let i=0;i<results.length;i++){
      const r=results[i]!,q=queries[i]!;
      if(r.budgetReduced){r.reduction={requested:q.limit,returned:r.items.length,reason:r.reduction?.reason || "Shared response byte budget"};}
      progress(r,q);
    }
    const summary={searched:results.map(r=>r.source),failed:results.filter(r=>r.status === "error").map(r=>r.source),partial:results.filter(r=>r.status === "partial").map(r=>r.source),more:results.filter(r=>r.nextCursor).map(r=>r.source)};
    const result={...output,summary};assertPacket(result);return result;
  }
  async function read_record(input: unknown): Promise<{record:ReturnType<typeof textPage>;context:unknown[];contextWarnings:string[];preview?:unknown}> {
    const request = readSchema.parse(input), ref = request.ref, wantContext=request.context && !request.cursor;
    requireSource(config,ref.source);
    let record, context: unknown[] = [], contextWarnings: string[] = [];
    if(ref.source === "library")record=await readLibrary(config,ref,r=>read_record({ref:r}));
    else if(ref.source === "documents"){record=await readDocument(config,ref);if(record.metadata?.mailRef)await read_record({ref:record.metadata.mailRef});}
    else if (ref.source.startsWith("mail-")) {
      record = await readMail(ref.source as MailSource, ref.id, mailExecute, config);
      assertVersion(ref,record.ref.version!);
      if (wantContext) {
        try { const c = await mailContext(record, mailExecute, config); context = c.records; contextWarnings = c.warnings; }
        catch (e) { const error = errorData(e); contextWarnings = [`Thread context unavailable: ${error.code}: ${error.message}`]; }
      }
    } else if (ref.source === "messages") {
      const result = await readMessage(config, ref, wantContext); record = result.record; context = result.context;
    } else if (ref.source === "journals") record = await journalRecord(config, ref);
    else if (ref.source === "whatsapp" || ref.source === "calls") { const r = await readDatabase(config, ref, wantContext); record = r.record; context = r.context; }
    else if (ref.source === "voice-journals" || ref.source === "call-notes") record = await readNote(config, ref);
    else if (ref.source === "calendar" || ref.source === "contacts") record = await readPim(config, ref);
    else if (ref.source.startsWith("chrome-")) record = await readChrome(config, ref);
    else if (ref.source === "vault") record = await readQmd(config, ref);
    else if (ref.source === "agent-history") record = await readCass(config, ref, request.context);
    else {
      record = await readExport(config, ref);
      if(ref.source === "chatgpt-archive" && wantContext){const c=await chatGptContext(config,record);context=c.records;contextWarnings=c.warnings;}
      if(ref.source === "twitter-archive" && wantContext){const c=await twitterArchiveContext(config,record);context=c.records;contextWarnings=c.warnings;}
      if(ref.source === "linkedin-archive" && wantContext){const c=await linkedInContext(config,record);context=c.records;contextWarnings=c.warnings;}
    }
    if(request.context && !["mail-personal","mail-consulting","mail-fastmail","messages","whatsapp","agent-history","chatgpt-archive","linkedin-archive","twitter-archive"].includes(ref.source))contextWarnings.push("This source does not support neighboring/thread context; the original record is returned.");
    if(request.context && ref.source === "messages" && !record.conversation)contextWarnings.push("No unambiguous conversation was found; neighboring messages are unavailable.");
    const result = { record: textPage(request.focus ? {...compactRecord(record,request.details),body:compactRecord(record).body} : compactRecord(record,request.details), request.cursor,request.focus), context:request.cursor?[]:context, contextWarnings:request.cursor?[]:contextWarnings };
    const originalCount=result.context.length;
    while(result.context.length && packetBytes(result)>42*1024)result.context.pop();
    if(result.context.length<originalCount)result.contextWarnings.push("Context was shortened to fit the response budget; read neighboring references separately.");
    assertPacket(result);
    const preview=request.preview ? await writePreview(result.record,config.previews) : undefined;
    const output={...result,...(preview ? {preview} : {})};assertPacket(output);return output;
  }
  return { list_sources, search_sources, read_record };
}

export async function boundedMap<T,R>(items:readonly T[],work:(item:T)=>Promise<R>,concurrency=4):Promise<R[]> {
  const result:R[]=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(next<items.length){const index=next++;result[index]=await work(items[index]!);}}));
  return result;
}
