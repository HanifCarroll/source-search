import {sourceGroups} from '../platform/source-settings';
import {sourceKind} from '../domain/source-catalog';
import {createSourceAccess} from "./source-access";
import type {Run} from "../sources/mail/index";
import {writePreview} from "./preview";
import {describeSource} from "./catalogue";
import {sourceEnabled, configuredSourceIds, type Config} from "../platform/config";
import {querySchema, searchSchema, readSchema, type Page} from "../domain/contracts";
import {canTrimItems} from "../domain/source-policy";
import {textPage, assertPacket, packetBytes} from "../domain/results";
import {compactRecord, annotateDuplicates, progress} from "../domain/presentation";
import {errorData, now} from "../domain/identity";
import {boundedMap} from './concurrency';
import {contextTools} from './context';
export {boundedMap} from './concurrency';

export function createRuntime(config: Config, execute?: Run) {
  const groups=sourceGroups(config);
  const access = createSourceAccess(config, execute);
  async function list_sources() {
    const sources = await boundedMap(configuredSourceIds(config), async source => {
      const base = { source, readOnly: true, checkedAt: now() };
      if(!sourceEnabled(config,source))return {...base,available:false,state:"disabled",error:{code:"SOURCE_DISABLED",message:"Enable this source in local configuration"}};
      try { return {...base,...await access.status(source)};
      } catch (e) { return { ...base, available: false, error: errorData(e) }; }
    });
    const described=sources.map(s=>describeSource(config,s));
    const result = {sources:described,groups,summary:{ready:described.filter(s=>s.state === "ready").length,total:described.length},connection:{codeReload:"Automatic on the next request after installing the updated MCP gateway",initialRefresh:"Connections started before this gateway update require a one-time reconnect"}}; assertPacket(result); return result;
  }
  async function search_sources(input: unknown) {
    const search = access.searchSession();
    const selection=searchSchema.parse(input);
    const queries=selection.queries.flatMap(q=>q.source in groups ? groups[q.source as keyof typeof groups].map(source=>querySchema.parse({...q,source})) : [querySchema.parse(q)]);
    if(new Set(queries.map(q=>q.source)).size!==queries.length)throw Error("Source selections overlap; choose each source once");
    async function fetchPage(q:ReturnType<typeof querySchema.parse>):Promise<Page> {
      try {
        const result = await search(q);
        progress(result,q,sourceKind(q.source,config));
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
      if (!canTrimItems(queries[results.indexOf(result)]!,config)) {
        // shortcut: Gmail/CASS have no safe intra-page token here; retry smaller pages until their providers expose one.
        const index=results.indexOf(result), q=queries[index];
        results[index]=await fetchPage({...q,limit:Math.max(1,Math.floor(result.items.length/2))});
        results[index].budgetReduced=true;
      } else result.nextCursor = result.items.at(-1)!.cursorAfter;
    }
    for(let i=0;i<results.length;i++){
      const r=results[i]!,q=queries[i]!;
      if(r.budgetReduced){r.reduction={requested:q.limit,returned:r.items.length,reason:r.reduction?.reason || "Shared response byte budget"};}
      progress(r,q,sourceKind(q.source,config));
    }
    const summary={searched:results.map(r=>r.source),failed:results.filter(r=>r.status === "error").map(r=>r.source),partial:results.filter(r=>r.status === "partial").map(r=>r.source),more:results.filter(r=>r.nextCursor).map(r=>r.source)};
    const result={...output,summary};assertPacket(result);return result;
  }
  async function read_record(input: unknown): Promise<{record:ReturnType<typeof textPage>;context:unknown[];contextWarnings:string[];preview?:unknown}> {
    const request = readSchema.parse(input);
    const {record, context = [], contextWarnings = []} = await access.read(request.ref, {context:request.context,continuation:!!request.cursor});
    const result = { record: textPage(request.focus ? {...compactRecord(record,request.details),body:compactRecord(record).body} : compactRecord(record,request.details), request.cursor,request.focus), context:request.cursor?[]:context, contextWarnings:request.cursor?[]:contextWarnings };
    const originalCount=result.context.length;
    while(result.context.length && packetBytes(result)>42*1024)result.context.pop();
    if(result.context.length<originalCount)result.contextWarnings.push("Context was shortened to fit the response budget; read neighboring references separately.");
    assertPacket(result);
    const preview=request.preview ? await writePreview(result.record,config.previews) : undefined;
    const output={...result,...(preview ? {preview} : {})};assertPacket(output);return output;
  }
  const context=contextTools(config,{read:ref=>access.read(ref),search:async query=>(await search_sources({queries:[query]})).results[0]!});
  return { list_sources, search_sources, read_record, ...context };
}
