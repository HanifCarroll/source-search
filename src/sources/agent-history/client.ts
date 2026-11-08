import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Config } from '../../platform/config';
import { agentsviewServerSchema } from '../../platform/source-settings';
import { fail } from '../../domain/identity';

const text = z.string();
const ordinal = z.number().int().nonnegative().safe();
const revision = z.string().min(1).max(100);
const nullableText = text.nullish();
const sessionSchema = z.object({
  id: text.min(1).max(2000), project: text, machine: text, agent: text,
  first_message: nullableText, display_name: nullableText,
  started_at: nullableText, ended_at: nullableText, message_count: ordinal,
  cwd: nullableText, git_branch: nullableText, transcript_revision: revision,
});
const messageSchema = z.object({
  ordinal, role: text, content: text, thinking_text: nullableText, timestamp: nullableText,
  has_tool_use: z.boolean().optional(),
  tool_calls: z.array(z.object({tool_name: text, category: nullableText,
    input_json: nullableText, result_content: nullableText})).nullish(),
});
const searchSchema = z.object({
  matches: z.array(z.object({
    session_id: text.min(1).max(2000), project: text, agent: text, machine: text,
    display_name: nullableText, location: text, role: text, ordinal,
    timestamp: nullableText, snippet: text, ordinal_range: z.tuple([ordinal,ordinal]).optional(),
    transcript_revision: revision, score: z.number().finite().nullish(), subordinate: z.boolean().optional(),
  })).max(25),
  next_cursor: ordinal.optional(), revision_bound: z.boolean(),
  coverage: z.object({status:text,lexical:z.object({status:text}),
    semantic:z.object({status:text,reason:nullableText})}),
});
const messagesSchema = z.object({messages:z.array(messageSchema).max(11),count:ordinal,
  transcript_revision:revision});
const versionSchema = z.object({version:text.min(1).max(100),api_version:ordinal,data_version:ordinal});
export type AgentMessage = z.infer<typeof messageSchema>;
export type AgentSession = z.infer<typeof sessionSchema>;
export type AgentsViewFetch = (input: string, init: RequestInit) => Promise<Response>;

const archiveWarning = 'AgentsView archive is stale and needs a rebuild by its owner; indexed coverage may be incomplete.';
export class AgentsViewClient {
  private server: string;
  constructor(private config: Pick<Config,'agentsviewServer'|'agentsviewTokenFile'>,
    private fetcher: AgentsViewFetch = (url,init)=>fetch(url,init),
    private timeoutMs = 30_000, private maxBytes = 4 * 1024 * 1024) {
    const server=agentsviewServerSchema.safeParse(config.agentsviewServer);
    if(!server.success || !config.agentsviewTokenFile || !isAbsolute(config.agentsviewTokenFile) || config.agentsviewTokenFile.includes('\0'))fail('SOURCE_NOT_CONFIGURED','Configure AgentsView server and an absolute tokenFile for agent-history.');
    this.server=server.data.replace(/\/$/,'');
  }
  private async token() {
    // Bound the credential read too, and reopen it for every request (rotation).
    let file;
    try {
      file=await open(this.config.agentsviewTokenFile!,'r');
      const bytes=Buffer.alloc(16_385),{bytesRead}=await file.read(bytes,0,bytes.length,0);
      const value=bytes.subarray(0,bytesRead).toString('utf8').trim();
      if(bytesRead===bytes.length || !value || /[\r\n\0]/.test(value))throw Error();
      return value;
    } catch { return fail('PERMISSION_DENIED','AgentsView tokenFile is unreadable, empty or invalid; check the configured credential file.'); }
    finally { await file?.close(); }
  }
  private async get<T>(path:string, schema:z.ZodType<T>, params:Record<string,string|number|undefined>={}, headers:Record<string,string>={}) {
    const url=new URL(this.server+path);
    for(const [key,value] of Object.entries(params))if(value!==undefined)url.searchParams.set(key,String(value));
    const token=await this.token(),controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    let response:Response|undefined;
    try {
      try { response=await this.fetcher(url.toString(),{method:'GET',headers:{...headers,Authorization:'Bearer '+token,Accept:'application/json'},signal:controller.signal,redirect:'error'}); }
      catch { fail('SOURCE_NOT_READY','AgentsView server is unreachable or the request timed out.'); }
      if(response.status===401 || response.status===403)fail('PERMISSION_DENIED','AgentsView authentication failed; check tokenFile and server access.');
      if(response.status===409)fail('STALE_RECORD','AgentsView transcript changed; search again for its current reference.');
      if(response.status===404)fail('NOT_FOUND','AgentsView session or endpoint was not found; search again.');
      // 501 is AgentsView's "semantic search not available" family (index missing, building or stale).
      if(response.status===501) {
        let reason='';
        try { const body=JSON.parse((await response.text()).slice(0,2000));if(typeof body?.error==='string')reason=body.error.replaceAll(token,'[redacted]').replace(/[\r\n\0]/g,' ').slice(0,300); } catch {}
        fail('SEMANTIC_UNAVAILABLE',reason || 'AgentsView semantic search is not available.');
      }
      if(!response.ok)fail(response.status>=500?'SOURCE_NOT_READY':'SOURCE_HTTP_ERROR',`AgentsView request failed (HTTP ${response.status}).`);
      if(Number(response.headers.get('content-length'))>this.maxBytes)fail('SOURCE_LIMIT','AgentsView response exceeded the byte limit; request a smaller window.');
      const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let used=0;
      if(!reader)fail('UNSUPPORTED_SCHEMA','AgentsView returned an empty response.');
      try {
        while(true) {
          const {done,value}=await reader.read();if(done)break;
          used+=value.byteLength;
          if(used>this.maxBytes)fail('SOURCE_LIMIT','AgentsView response exceeded the byte limit; request a smaller window.');
          chunks.push(value);
        }
      } catch(error) {
        if((error as {code?:string}).code==='SOURCE_LIMIT')throw error;
        fail('SOURCE_NOT_READY','AgentsView response was interrupted or timed out.');
      } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
      // Never expose a credential even if a server echoes it in a success body.
      const raw=Buffer.concat(chunks).toString('utf8');
      let json:unknown;try { json=JSON.parse(raw,(_key,value)=>typeof value==='string'?value.replaceAll(token,'[redacted]'):value); } catch { fail('UNSUPPORTED_SCHEMA','AgentsView returned invalid JSON.'); }
      const result=schema.safeParse(json);
      if(!result.success)fail('UNSUPPORTED_SCHEMA','AgentsView returned an invalid response shape.');
      return {data:result.data,warnings:response.headers.get('X-Agentsview-Archive-Stale')?.toLowerCase()==='true'?[archiveWarning]:[]};
    } finally { clearTimeout(timer);await response?.body?.cancel().catch(()=>{}); }
  }
  version() { return this.get('/api/v1/version',versionSchema); }
  search(params:Record<string,string|number|undefined>, headers:Record<string,string>={}) { return this.get('/api/v1/search/content',searchSchema,params,headers); }
  session(id:string) { return this.get('/api/v1/sessions/'+encodeURIComponent(id),sessionSchema); }
  messages(id:string,around:number,context:number,expectedRevision:string) {
    return this.get('/api/v1/sessions/'+encodeURIComponent(id)+'/messages',messagesSchema,
      {around,before:context,after:context,expected_revision:expectedRevision});
  }
}
