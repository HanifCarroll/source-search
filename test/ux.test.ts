import { test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { defaultConfig } from "./helpers/config";
import { createRuntime } from "../src/application/runtime";
import { querySchema } from "../src/domain/contracts";
import { textPage, assertPacket } from "../src/domain/results";
import { matchesQuery } from "../src/domain/query";
import { readableMail, compactRecord, annotateDuplicates } from "../src/domain/presentation";
import { describeSource } from "../src/application/catalogue";
import { scanRecords } from "../src/domain/scan";
import { runtimeLoader } from "../src/interfaces/runtime-loader";
import { searchMail } from "./helpers/mail";
import { createZip } from "./helpers/zip";
import { rebuildArchive } from "../src/sources/archives/index";
import { parseSafeZipArchive } from "../src/vendor/takeout/zip";
const roots: string[] = [];
async function folder() { const r = await mkdtemp(join(tmpdir(), "source-search-ux-")); roots.push(r); return r; }
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
test("readable HTML, snippets, compact provenance and continuation", () => {
    expect(readableMail('<!doctype html><html><style>SECRET_CSS</style><body><p>First &amp; second</p><p>Another paragraph</p></body></html>')).toContain('First & second');
    expect(readableMail('<html><script>script()</script><body>Visible</body></html>')).not.toContain('script()');
    expect(readableMail('<div>HTML fragment &amp; text</div>')).toBe('HTML fragment & text');
    const record = { ref: { source: 'takeout-archive' as const, id: 'x' }, body: 'Original text', title: 'Mail', type: 'email', locator: '/synthetic/archive.zip#mail', observedAt: '', metadata: { headers: { 'message-id': ['<fixture@example.test>'], 'x-gm-thrid': ['255'], received: ['raw routing'] } } };
    const compact = compactRecord(record);
    expect(compact.metadata?.headers).toBeUndefined();
    expect(compact.metadata?.messageId).toBe('<fixture@example.test>');
    expect(compact.metadata?.openLink).toEndWith('/ff');
    expect(compactRecord(record, true).metadata?.headers).toBeDefined();
    const long = { ...compact, body: '😀'.repeat(9000) };
    const first = textPage(long);
    const second = textPage(long, first.nextCursor);
    expect(second.metadata).toBeUndefined();
    expect(second.page.offset).toBe(first.body.length);
    assertPacket(second);
});
test("word prefixes and phrases exclude note metadata", async () => {
    expect(matchesQuery('programming systems', { query: 'programm syst' })).toBe(true);
    expect(matchesQuery('first systems then programming', { query: 'programming systems', match: 'phrase' })).toBe(false);
    const root = await folder(), c = { ...defaultConfig(), journals: root, voiceNotes: root };
    await writeFile(join(root, '2024-01-01.md'), 'fixture written journal');
    await writeFile(join(root, '2024-01-01 - Voice - Fixture.md'), '---\nbackend: metadataonly\n---\nfixture voice transcript');
    const runtime = createRuntime(c), result = await runtime.search_sources({ queries: [{ source: 'all-journals', query: 'fixture' }] });
    expect(result.results).toHaveLength(2);
    expect(result.summary.searched).toEqual(['journals', 'voice-journals']);
    const metadata = await runtime.search_sources({ queries: [{ source: 'voice-journals', query: 'metadataonly' }] });
    expect(metadata.results[0].items).toHaveLength(0);
    expect((await runtime.search_sources({queries:[{source:'journals',query:'fixture',excludeSpamTrash:true}]})).results[0].error?.code).toBe('UNSUPPORTED_FILTER');
    expect((await runtime.search_sources({queries:[{source:'contacts',query:'fixture',sort:'oldest'}]})).results[0].error?.code).toBe('UNSUPPORTED_SORT');
    const ref = result.results[1].items[0].ref;
    expect((await runtime.read_record({ ref, context: true })).contextWarnings[0]).toContain('does not support');
    await expect(runtime.search_sources({ queries: [{ source: 'all-journals', query: '' }, { source: 'journals', query: '' }] })).rejects.toThrow('overlap');
});
test("readiness is distinct from access, with missing-folder recovery", () => {
    const c = defaultConfig();
    expect(describeSource(c, { source: 'things-archive', available: true, index: { stale: true } }).state).toBe('stale');
    expect(describeSource(c, { source: 'chatgpt-archive', available: false, error: { code: 'SOURCE_NOT_CONFIGURED' } }).state).toBe('waiting-for-export');
    expect(describeSource(c, { source: 'voice-journals', available: false, error: { code: 'ENOENT' } }).recovery).toContain('config.json');
    expect(describeSource(c, { source: 'mail-fastmail', available: true }).capabilities.filters).toContain('folders');
});
test("date/ID keyset preserves nanosecond precision and oldest ordering", () => {
    const db = new Database(':memory:', { safeIntegers: true });
    db.exec('CREATE TABLE rows(id INTEGER,time INTEGER)');
    for (let i = 1; i <= 4; i++)
        db.query('INSERT INTO rows VALUES(?,?)').run(i, 700000000000000000n + BigInt(i));
    const q = querySchema.parse({ source: 'messages', query: 'fixture', sort: 'oldest', limit: 1 });
    const convert = (r: any) => ({ ref: { source: 'messages' as const, id: String(r.id) }, title: 'fixture', body: 'fixture', type: 'message', locator: 'source-search://messages/' + r.id, observedAt: '' });
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
        const p = scanRecords(db, 'SELECT id,time FROM rows', [], [], 'time', 'id', { ...q, cursor }, convert);
        ids.push(...p.items.map(h => h.ref.id));
        cursor = p.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['1', '2', '3', '4']);
    db.close();
});
test("loader retains the code path needed by lazy bundled native imports", async () => {
    const root=await folder(),entry=join(root,'api.ts');
    await writeFile(entry,'export async function invoke(){const {Database}=await import("bun:sqlite");const db=new Database(":memory:");const row=db.query("SELECT 1 value").get();db.close();return {row,path:import.meta.path};}');
    const load=runtimeLoader(entry),result=await (await load()).invoke('list_sources',{}) as any;
    expect(result.row.value).toBe(1);expect(await Bun.file(result.path).exists()).toBe(true);
});
test("loader keeps lazy native imports readable across fresh bundle directories",async()=>{
    const root=await folder(),entry=join(root,'api.ts'),load=runtimeLoader(entry),paths:string[]=[];
    for(let i=0;i<3;i++){
        await writeFile(entry,`export async function invoke(){const {Database}=await import("bun:sqlite");const db=new Database(":memory:");db.query("SELECT ${i}").get();db.close();return {path:import.meta.path};}`);
        const r=await (await load()).invoke('list_sources',{}) as any;paths.push(r.path);
        expect(await Bun.file(r.path).exists()).toBe(true);
    }
    expect(new Set(paths.map(p=>p.slice(0,p.lastIndexOf('/')))).size).toBe(3);
    for(const path of paths)expect(await Bun.file(path).exists()).toBe(true);
});
test("mail passes date/folder filters without writes and normalizes UTC dates", async () => {
    let call: string[] = [];
    const page = await searchMail(querySchema.parse({ source: 'mail-fastmail', query: 'invoice', from: '2024-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z', folders: ['Archive'], excludeSpamTrash: true, sort: 'oldest' }), async (argv) => { call = argv; return { position: 0, queryState: 'stable', total: 1, nextPosition: null, messages: [{ message_id: 'fixture', date: '2024-02-01T00:00:00Z', folders: [{ name: 'Archive', role: 'archive' }] }] }; });
    expect(call).toContain('--after');
    expect(call).toContain('--folder');
    expect(call).toContain('--exclude-spam-trash');
    expect(call).toContain('--oldest');
    expect(call.some(s => ['send', 'archive', 'draft'].includes(s))).toBe(false);
    expect(page.totalMatches).toBe(1);
    expect(page.items[0].metadata?.folders).toEqual([{ name: 'Archive', role: 'archive' }]);
});
test("loader applies runtime changes without restarting its caller", async () => {
    const root = await folder(), entry = join(root, 'api.ts');
    await writeFile(entry, 'let disposed=false; export function dispose(){disposed=true;} export async function invoke(){return disposed ? {disposed:true} : {revision:1}}');
    const load = runtimeLoader(entry);
    const original=await load();
    expect(JSON.stringify(await original.invoke('list_sources', {}))).toBe('{"revision":1}');
    await writeFile(entry, 'export async function invoke(){return {revision:2}}');
    expect(JSON.stringify(await (await load()).invoke('list_sources', {}))).toBe('{"revision":2}');
    expect(JSON.stringify(await original.invoke('list_sources',{}))).toBe('{"disposed":true}');
    await writeFile(entry, 'let disposed=false; export function dispose(){disposed=true;} export async function invoke(){return disposed ? {disposed:true} : {revision:1}}');
    expect(JSON.stringify(await (await load()).invoke('list_sources', {}))).toBe('{"revision":1}');
    await writeFile(entry, 'this is invalid Typescript!');
    await expect(load()).rejects.toThrow('could not load');
    await writeFile(entry, 'export async function invoke(){return {revision:3}}');
    expect(JSON.stringify(await (await load()).invoke('list_sources', {}))).toBe('{"revision":3}');
});
test("loader reloads an embedded Node worker when only its source changes", async () => {
    const root = await folder(), entry = join(root, 'api.ts'), worker=join(root,'worker.mjs');
    await writeFile(worker, 'export const revision=1;');
    await writeFile(entry, 'import source from "./worker.mjs" with {type:"text"}; export async function invoke(){return {source}}');
    const load=runtimeLoader(entry);
    expect(JSON.stringify(await (await load()).invoke('list_sources',{}))).toContain('revision=1');
    await writeFile(worker,'export const revision=2;');
    expect(JSON.stringify(await (await load()).invoke('list_sources',{}))).toContain('revision=2');
});
test("archive type/date/sort filters and warm original reads retain stale-source checks", async () => {
    const root = await folder(), things = join(root, 'things');
    await mkdir(things);
    for (const [name, text] of Object.entries({ 'tasks.jsonl': '', 'context.json': '{"TMTask":[]}', 'snapshot-info.json': '{"taskCount":0,"exportedAt":"2024-01-01T00:00:00Z"}' }))
        await writeFile(join(things, name), text);
    const zip = join(root, 'takeout.zip'), c = { ...defaultConfig(), things, index: join(root, 'index.sqlite'), takeout: [zip] };
    const mbox = 'From fixture@example.test Mon Jan 1 00:00:00 2024\nMessage-ID: <fixture@example.test>\nDate: Mon, 1 Jan 2024 00:00:00 +0000\nSubject: Programming\n\nProgramming original text\n';
    await writeFile(zip, await createZip([{ path: 'Takeout/Mail/All mail Including Spam and Trash.mbox', text: mbox }, { path: 'Takeout/Calendar/Events.ics', text: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fixture\r\nDTSTART:20250101T000000Z\r\nSUMMARY:Programming\r\nEND:VEVENT\r\nEND:VCALENDAR' }]));
    await rebuildArchive(c);
    const runtime = createRuntime(c), p = (await runtime.search_sources({ queries: [{ source: 'takeout-archive', query: 'programm', types: ['email'], sort: 'oldest', from: '2024-01-01T00:00:00Z', to: '2024-12-01T00:00:00Z' }] })).results[0];
    expect(p.scan?.exhausted).toBe(true);
    expect(p.progress?.hasMore).toBe(false);
    expect((await runtime.search_sources({queries:[{source:'takeout-archive',query:'programm',types:['email'],sort:'oldest',from:'2024-01-01T00:00:00Z',to:'2024-12-01T00:00:00Z',cursor:p.items[0].cursorAfter}]})).results[0].status).toBe('ok');
    const ref = p.items[0].ref;
    expect((await runtime.read_record({ ref })).record.body).toContain('Programming original text');
    expect((await runtime.read_record({ ref })).record.body).toContain('Programming original text');
    await writeFile(zip, await createZip([{ path: 'Takeout/Mail/All mail Including Spam and Trash.mbox', text: mbox.replace('original text', 'changed text') }]));
    await expect(runtime.read_record({ ref })).rejects.toThrow('changed');
    const stale=(await runtime.search_sources({queries:[{source:'takeout-archive',query:'programm'}]})).results[0];
    expect(stale.error?.code).toBe('INDEX_STALE');
});
test('mail duplicates retain evidence and avoid conflicting Message-IDs',()=>{
    const base={title:'Fixture',type:'email',author:'Sender <sender@example.test>',occurredAt:'2024-01-01T00:00:00Z',observedAt:'',locator:'source-search://fixture',metadata:{}};
    const a={...base,ref:{source:'takeout-archive' as const,id:'a'},metadata:{messageId:'<a@example.test>'}};
    const b={...base,ref:{source:'mail-personal' as const,id:'b'},metadata:{}};
    const c={...base,ref:{source:'mail-personal' as const,id:'c'},metadata:{messageId:'<c@example.test>'}};
    annotateDuplicates([a,b,c]);
    expect((a.metadata as any).duplicateEvidence).toHaveLength(1);
    expect((b.metadata as any).duplicateEvidence).toHaveLength(2);
    expect((a.metadata as any).duplicateEvidence[0].reason).toContain('possible');
    annotateDuplicates([a,c]);
    expect((a.metadata as any).duplicateEvidence).toBeUndefined();
    const mail=compactRecord({...base,body:'text',ref:{source:'mail-fastmail',id:'fixture'},conversation:'thread',metadata:{folders:[{role:'trash'}]}});
    expect(mail.metadata?.openLink).toBe('https://app.fastmail.com/mail/Trash/search:in%3Atrash%20subject%3A%22Fixture%22/thread.fixture');
});
test('native ZIP decoding retains checksum and expansion validation',async()=>{
    const bytes=await createZip([{path:'fixture.txt',text:'Original compressed text',method:8}]);
    const zip=await parseSafeZipArchive(bytes);
    expect(new TextDecoder().decode(await zip.readEntry(zip.entries[0]))).toBe('Original compressed text');
    const corrupt=bytes.slice();
    const central=new DataView(corrupt.buffer).getUint32(corrupt.length-6,true);
    corrupt[central+16]^=1;
    await expect(parseSafeZipArchive(corrupt)).rejects.toThrow();
    const oversized=bytes.slice();
    new DataView(oversized.buffer).setUint32(central+24,1,true);
    new DataView(oversized.buffer).setUint32(22,1,true);
    const bound=await parseSafeZipArchive(oversized,{maxEntryBytes:1});
    await expect(bound.readEntry(bound.entries[0])).rejects.toThrow();
    await expect(parseSafeZipArchive(bytes,{maxEntryBytes:1})).rejects.toThrow('safety limit');
});
test('oversized native mail pages retry smaller without skipping provider continuation',async()=>{
    const c=defaultConfig();
    const all=Array.from({length:30},(_,i)=>({id:'m'+i,subject:'Fixture '+i+'x'.repeat(250),from:'x'.repeat(500),snippet:'fixture '+'x'.repeat(500),to:['x'.repeat(4000)]}));
    const execute=async(argv:string[])=>{const n=Number(argv[argv.indexOf('--max')+1]);const p=argv.indexOf('--page'),start=p>=0?Number(argv[p+1]):0;return {messages:all.slice(start,start+n),nextPageToken:start+n<all.length?String(start+n):undefined};};
    const runtime=createRuntime(c,execute);
    const first=(await runtime.search_sources({queries:[{source:'mail-personal',query:'fixture',limit:25},{source:'mail-consulting',query:'fixture',limit:25}]})).results[0];
    expect(first.budgetReduced).toBe(true);
    expect(first.items.length).toBeLessThan(25);
    const second=(await runtime.search_sources({queries:[{source:'mail-personal',query:'fixture',limit:25,cursor:first.nextCursor}]})).results[0];
    expect(second.items[0].ref.id).toBe('m'+first.items.length);
});
test('loader applies dependency-only upgrades when the lockfile changes',async()=>{
 const root=await folder(),entry=join(root,'api.ts'),dep=join(root,'node_modules','fixture-parser');await mkdir(dep,{recursive:true});
 await writeFile(join(dep,'package.json'),JSON.stringify({name:'fixture-parser',type:'module',main:'index.js'}));
 await writeFile(entry,'import {version} from "fixture-parser";export async function invoke(){return {revision:version};}');
 await writeFile(join(dep,'index.js'),'export const version=1;');await writeFile(join(root,'bun.lock'),'fixture version 1');const load=runtimeLoader(entry);
 expect(await (await load()).invoke('list_sources',{})).toMatchObject({revision:1});
 await writeFile(join(dep,'index.js'),'export const version=2;');await writeFile(join(root,'bun.lock'),'fixture version 2');
 expect(await (await load()).invoke('list_sources',{})).toMatchObject({revision:2});
});
test('bundled runtime resolves SDK workers from the installed checkout',async()=>{
 const root=await folder(),entry=join(root,'api.ts');
 await writeFile(entry,`import {packageRoot} from ${JSON.stringify(join(import.meta.dir,'../src/platform/package-root.ts'))};export async function invoke(){return {root:packageRoot};}`);
 const load=runtimeLoader(entry);
 expect(await (await load()).invoke('list_sources',{})).toMatchObject({root});
});
test('an already-running gateway without the newer build define still uses its own installation',async()=>{
 const root=await folder(),bundleRoot=await folder(),entry=join(root,'api.ts'),launcher=join(root,'src/mcp.ts');
 await mkdir(join(root,'src'));await writeFile(join(root,'package.json'),JSON.stringify({name:'source-search',type:'module'}));
 await writeFile(entry,`import {packageRoot} from ${JSON.stringify(join(import.meta.dir,'../src/platform/package-root.ts'))};export const root=packageRoot;`);
 const build=await Bun.build({entrypoints:[entry],target:'bun'});expect(build.success).toBe(true);
 const bundle=join(bundleRoot,'runtime.mjs');await writeFile(bundle,await build.outputs[0]!.text());
 await writeFile(launcher,`import {root} from ${JSON.stringify(bundle)};console.log(JSON.stringify({root}));`);
 const child=Bun.spawn([process.execPath,launcher],{stdout:'pipe',stderr:'pipe',cwd:bundleRoot});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(code,err).toBe(0);expect(await realpath(JSON.parse(out).root)).toBe(await realpath(root));
});
