import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedInRecords, linkedInType, linkedInArticle } from "../src/linkedin";
import { parseCsv } from "../src/vendor/takeout/parsers";
import { createZip } from "./helpers/zip";
import { defaultConfig } from "./helpers/config";
import { rebuildArchive, indexStatus } from "../src/archive";
import { exportRecords } from "../src/exports";
import { createRuntime } from "../src/runtime";
import { describeSource } from "../src/catalogue";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const messages='CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT\r\nfixture-thread,Project,Alex,https://www.linkedin.com/in/fixture-alex,Alex,2024-01-01 10:00:00 UTC,Project,"Hello, fixture\nSecond line with ""quotes"""\r\nfixture-thread,Project,Alex,https://www.linkedin.com/in/fixture-alex,Alex,2024-01-02 10:00:00 UTC,Project,Fixture reply\r\n';
test('LinkedIn CSV preserves quoted original fields, dates, authors and category boundaries',()=>{
  expect(describeSource(defaultConfig(),{source:'linkedin-archive',available:false,error:{code:'SOURCE_NOT_CONFIGURED'}}).capabilities.filters).toEqual(['from','to','types','conversation','sections']);
  const records=linkedInRecords('\uFEFF'+messages,'/fixture.zip','Messages.CSV',0);
  expect(records).toHaveLength(2);
  expect(records[0].body).toContain('Hello, fixture\nSecond line with "quotes"');
  expect(records[0].author).toBe('Alex');
  expect(records[0].conversation).toBe('fixture-thread');
  expect(records[0].occurredAt).toBe('2024-01-01T10:00:00.000Z');
  expect(linkedInRecords(messages.replace('2024-01-01 10:00:00 UTC','2024-01-01T10:00:00 UTC'),'/fixture.zip','Messages.csv',0)[0].occurredAt).toBe(records[0].occurredAt);
  expect(records[0].type).toBe('linkedin-message');
  const connections=linkedInRecords('Notes:\nProvider notes\n\nFirst Name,Last Name,URL,Connected On\nAlex,Fixture,https://www.linkedin.com/in/fixture-alex,1 Jan 2013\n','/fixture.zip','Connections.csv',0);
  expect(connections[0].occurredAt).toBe('2013-01-01T00:00:00.000Z');
  expect(connections[0].metadata?.datePrecision).toBe('day');
  expect(connections[0].metadata?.timezone).toBe('unspecified');
  const ambiguous=linkedInRecords('Date,Content\n2024-01-01 10:00:00,Original fixture\n','/fixture.zip','Messages.csv',0);
  expect(ambiguous[0].occurredAt).toBe('2024-01-01T00:00:00.000Z');
  expect(ambiguous[0].metadata?.timezone).toBe('unspecified');expect(ambiguous[0].metadata?.datePrecision).toBe('day');
  const repeated=linkedInRecords('From,From\nAlex,Other\n','/fixture.zip','Messages.csv',0)[0];
  expect(repeated.body).toContain('From: Alex\n\nFrom: Other');expect(repeated.author).toBeUndefined();expect(repeated.metadata?.originalFields).toEqual([{name:'From',value:'Alex'},{name:'From',value:'Other'}]);
  expect(()=>linkedInRecords('From,FROM\nAlex,Other\n','/fixture.zip','Messages.csv',0)).toThrow('Ambiguous');
  expect(()=>linkedInRecords('From,Content\nAlex,body,extra\n','/fixture.zip','Messages.csv',0)).toThrow('column count');
  expect(()=>linkedInRecords('Content\n"unclosed','/fixture.zip','Messages.csv',0)).toThrow('unterminated');
  expect(linkedInRecords('Content\n','/fixture.zip','Messages.csv',0)).toHaveLength(0);
});

test('complete LinkedIn export preserves repeated columns, category suffixes, empty markers and explicit dates',()=>{
  const escaped=String.raw`Date,Link,Message
2024-01-01,https://www.linkedin.com/posts/fixture,"Fixture \"quoted\" text and C:\folder, with ""double quotes"""
`;
  expect(linkedInRecords(escaped,'/fixture.zip','Comments_123.csv',0)[0].body).toContain('Fixture "quoted" text and C:\\folder, with "double quotes"');
  expect(()=>parseCsv(escaped,'Takeout.csv')).toThrow('characters after');
  const record=linkedInRecords('Company Names,Company Names,Job Titles,Job Titles\nFixture A,Fixture B,Engineer,Designer\n','/fixture.zip','Ad_Targeting.csv',0)[0];
  for(const text of ['Company Names: Fixture A','Company Names: Fixture B','Job Titles: Engineer','Job Titles: Designer'])expect(record.body).toContain(text);
  expect(linkedInRecords('No conversations found\n\n\n','/fixture.zip','LearningCoachMessages.csv',0)).toHaveLength(0);
  expect(()=>linkedInRecords('No conversations found\nUnexpected record,extra\n','/fixture.zip','LearningCoachMessages.csv',0)).toThrow('column count');
  for(const [entry,type] of [['Shares_123.csv','linkedin-post'],['Comments_123.csv','linkedin-comment'],['Jobs/Job Applications_2.csv','linkedin-job-application']])expect(linkedInType(entry!)).toBe(type);
  const query=linkedInRecords('Time,Search Query\n2024/09/23 14:50:35 UTC,Fixture architecture\n','/fixture.zip','SearchQueries.csv',0)[0];
  expect(query.occurredAt).toBe('2024-09-23T14:50:35.000Z');expect(query.title).toBe('Fixture architecture');
  const rawQuery=linkedInRecords('Time,Search Query\n2024/09/23 14:50:35 UTC,"Fixture "quoted", query"\n','/fixture.zip','SearchQueries.csv',0)[0];
  expect(rawQuery.body).toContain('Search Query: "Fixture "quoted", query"');expect(rawQuery.warnings).toHaveLength(0);
  expect(linkedInRecords('Time,Search Query\n2024/09/23 14:50:35 UTC,"unclosed\n','/fixture.zip','SearchQueries.csv',0)[0].body).toContain('Search Query: "unclosed');
  expect(linkedInRecords('Time,Search Query\n2024/09/23 14:50:35 UTC,Fixture, raw query\n','/fixture.zip','SearchQueries.csv',0)[0].body).toContain('Search Query: Fixture, raw query');
  expect(()=>linkedInRecords('Time,Search Query\n2024/09/23 14:50:35 UTC,"Fixture "quoted" query"\ncontinuation line\n','/fixture.zip','SearchQueries.csv',0)).toThrow();
  const application=linkedInRecords('Application Date,Job Title\n"9/25/18, 6:38 PM",Engineer\n','/fixture.zip','Jobs/Job Applications_1.csv',0)[0];
  expect(application.occurredAt).toBe('2018-09-25T00:00:00.000Z');expect(application.metadata?.sourceDateField).toBe('Application Date');expect(application.metadata?.timezone).toBe('unspecified');expect(application.warnings).toHaveLength(0);
  const share=linkedInRecords('ShareCommentary,ShareLink\nFixture post,https://www.linkedin.com/posts/fixture\n','/fixture.zip','Shares_123.csv',0)[0];
  expect(share.title).toBe('Fixture post');expect(share.metadata?.url).toBe('https://www.linkedin.com/posts/fixture');
});

test('LinkedIn article HTML is searchable and readable from its unchanged original archive',async()=>{
  const root=await mkdtemp(join(tmpdir(),'source-search-linkedin-article-'));
  const entry='Articles/Articles/fixture.html',html='<html><head><title>Fixture &amp; Article</title><style>hidden style</style></head><body><h1><a href="https://www.linkedin.com/pulse/fixture">Fixture Article</a></h1><p class="published">Published on 2024-01-02 10:00</p><p>Searchable architecture &amp; evidence.</p><script>hidden script</script></body></html>';
  try {
    const things=join(root,'things');await mkdir(things);
    for(const [name,body] of Object.entries({'tasks.jsonl':'','context.json':'{"TMTask":[]}','snapshot-info.json':'{"taskCount":0,"exportedAt":"2024-01-01T00:00:00Z"}'}))await writeFile(join(things,name),body);
    const zip=join(root,'linkedin.zip'),bytes=await createZip([{path:'Profile.csv',text:'Name\nFixture\n'},{path:entry,text:html}]);await writeFile(zip,bytes);
    const c={...defaultConfig(),things,index:join(root,'index.sqlite'),linkedin:[zip]};await rebuildArchive(c);
    const runtime=createRuntime(c),result=(await runtime.search_sources({queries:[{source:'linkedin-archive',query:'architecture',types:['linkedin-article']}]})).results[0];
    expect(result.items).toHaveLength(1);
    const read=await runtime.read_record({ref:result.items[0].ref});expect(read.record.title).toBe('Fixture & Article');expect(read.record.body).toContain('architecture & evidence');expect(read.record.body).not.toContain('hidden');expect(read.record.metadata?.url).toBe('https://www.linkedin.com/pulse/fixture');expect(read.record.occurredAt).toBe('2024-01-02T00:00:00.000Z');expect(read.record.warnings).toHaveLength(0);
    expect(await readFile(zip)).toEqual(Buffer.from(bytes));
    expect(()=>linkedInArticle('<title>Malformed</title>',zip,entry,0)).toThrow('body');
    expect(linkedInArticle(html.replace('https://www.linkedin.com/pulse/fixture','https://linkedin.com.attacker.test/x'),zip,entry,0).metadata?.url).toBeUndefined();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('LinkedIn browsing uses descriptive titles and explicit upload/follow dates without guessing a timezone',()=>{
  const media=linkedInRecords('Date/Time,Media Description\n"You uploaded a feed photo on September 24, 2024 at 2:15 PM (GMT)","Fixture language project\nsecond line"\n','/fixture.zip','Rich_Media.csv',0)[0];
  expect(media.title).toBe('Fixture language project');
  expect(media.body).toContain('Fixture language project\nsecond line');
  expect(media.occurredAt).toBe('2024-09-24T14:15:00.000Z');
  expect(media.metadata?.dateKind).toBe('media-upload');
  expect(media.metadata?.sourceDateField).toBe('Date/Time');
  expect(linkedInRecords('Date/Time,Media Description\n"You uploaded a document on September 24, 2024 at 2:15 PM (UTC)",Fixture\n','/fixture.zip','Rich_Media.csv',0)[0].occurredAt).toBe(media.occurredAt);
  const follow=linkedInRecords('Organization,Followed On\nFixture Company,Mon Sep 14 16:04:53 UTC 2026\n','/fixture.zip','Company Follows.csv',0)[0];
  expect(follow.title).toBe('Fixture Company');
  expect(follow.occurredAt).toBe('2026-09-14T16:04:53.000Z');
  expect(follow.metadata?.sourceDateField).toBe('Followed On');
  expect(linkedInRecords('Title,Company Name\nEngineer,Fixture Company\n','/fixture.zip','Positions.csv',0)[0].title).toBe('Engineer at Fixture Company');
  expect(linkedInRecords('School Name\nFixture School\n','/fixture.zip','Education.csv',0)[0].title).toBe('Fixture School');
  for(const date of ['You uploaded a photo on September 24, 2024 at 2:15 PM','Mon Sep 14 16:04:53 2026']) {
    const undated=linkedInRecords('Date/Time,Media Description\n"'+date+'",Fixture\n','/fixture.zip','Rich_Media.csv',0)[0];
    expect(undated.occurredAt).toBeUndefined();expect(undated.metadata?.dateKind).toBe('undated');expect(undated.warnings).toHaveLength(1);
  }
});

test('LinkedIn archive shares search, pagination, original reads and MCP, and rejects changed or malformed exports',async()=>{
  const root=await mkdtemp(join(tmpdir(),'source-search-linkedin-'));
  let client:Client|undefined;
  try {
    const things=join(root,'things'); await mkdir(things);
    for(const [name,body] of Object.entries({'tasks.jsonl':'','context.json':'{"TMTask":[]}','snapshot-info.json':'{"taskCount":0,"exportedAt":"2024-01-01T00:00:00Z"}'}))await writeFile(join(things,name),body);
    const zip=join(root,'linkedin.zip'), c={...defaultConfig(),things,index:join(root,'index.sqlite'),linkedin:[zip]};
    const bytes=await createZip([{path:'Messages.csv',text:messages,method:8},{path:'Profile.csv',text:'First Name,Last Name,Headline\nAlex,Fixture,Engineer\n'},{path:'Invitations.csv',text:'From,To,Sent At\n'},{path:'Readme.txt',text:'Not evidence text'}]);
    await writeFile(zip,bytes); await rebuildArchive(c);
    const state=JSON.parse((await indexStatus(c))['linkedin-archive']);
    expect(state.categories).toContainEqual({entry:'Invitations.csv',records:0,recordType:'linkedin-invitation'});
    expect(state.dateCoverage).toEqual({datedRecords:2,undatedRecords:1});
    const described=describeSource(c,{source:'linkedin-archive',available:true,index:state});
    expect('types' in described.example && described.example.types).toEqual([state.recordTypes[0]]);
    expect(described.dateCoverage).toEqual(state.dateCoverage);
    const runtime=createRuntime(c);
    const missing=(await runtime.search_sources({queries:[{source:'linkedin-archive',query:'',types:['linkedin-connection']}]})).results[0];
    expect(missing.error?.code).toBe('TYPE_NOT_AVAILABLE');expect(missing.error?.message).toContain('selected');
    const empty=(await runtime.search_sources({queries:[{source:'linkedin-archive',query:'',types:['linkedin-invitation']}]})).results[0];
    expect(empty.status).toBe('ok');expect(empty.totalMatches).toBe(0);
    const browse=(await runtime.search_sources({queries:[{source:'linkedin-archive',query:''}]})).results[0];
    expect(browse.query?.sort).toBe('newest');
    const noTerms=(await runtime.search_sources({queries:[{source:'linkedin-archive',query:'!!!',sort:'relevance'}]})).results[0];
    expect(noTerms.query?.sort).toBe('newest');
    const undated=(await runtime.search_sources({queries:[{source:'linkedin-archive',query:'',types:['linkedin-profile'],from:'2020-01-01T00:00:00Z'}]})).results[0];
    expect(undated.totalMatches).toBe(0);expect(undated.sourceWarnings?.some(w=>w.includes('1 otherwise matching'))).toBe(true);
    const first=(await runtime.search_sources({queries:[{source:'linkedin-archive',query:'fixture',types:['linkedin-message'],sort:'oldest',conversation:'fixture-thread',limit:1}]})).results[0];
    expect(first.progress?.totalMatches).toBeNull();expect(first.nextCursor).toBeDefined();
    expect((await runtime.search_sources({queries:[{source:'linkedin-archive',query:'fixture'}]})).results[0].query?.sort).toBe('relevance');
    expect(first.items[0].excerpt).toContain('Hello, fixture');
    expect(first.sourceWarnings?.some(w=>w.includes('category counts'))).toBe(true);
    const second=(await runtime.search_sources({queries:[{source:'linkedin-archive',query:'fixture',types:['linkedin-message'],sort:'oldest',conversation:'fixture-thread',limit:1,cursor:first.nextCursor}]})).results[0];
    expect(second.items[0].ref.id).not.toBe(first.items[0].ref.id);
    expect(second.nextCursor).toBeUndefined();
    const read=await runtime.read_record({ref:first.items[0].ref});expect(read.record.body).toContain('Second line');
    expect(read.record.metadata?.profileUrl).toBe('https://www.linkedin.com/in/fixture-alex');
    expect(read.record.metadata?.openLink).toBeUndefined();expect(read.record.metadata?.openAction).toContain('preview:true');
    expect(await readFile(zip)).toEqual(Buffer.from(bytes));
    const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(c));
    client=new Client({name:'linkedin-fixture',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp.ts')],env:{...process.env as Record<string,string>,SOURCE_SEARCH_CONFIG_FILE:configPath},stderr:'pipe'}));
    const packet=await client.callTool({name:'read_record',arguments:{ref:first.items[0].ref}});
    expect(packet.isError).not.toBe(true);expect(JSON.parse((packet.content as any[])[0].text).record.body).toContain('Second line');
    const previous=await readFile(c.index);
    await writeFile(zip,await createZip([{path:'Messages.csv',text:'Content\n"unclosed'}]));
    await expect(rebuildArchive(c)).rejects.toThrow();expect(await readFile(c.index)).toEqual(previous);
    expect((await runtime.search_sources({queries:[{source:'linkedin-archive',query:'fixture'}]})).results[0].error?.code).toBe('INDEX_STALE');
    await writeFile(zip,await createZip([{path:'../Messages.csv',text:messages}]));
    await expect(exportRecords(c,'linkedin-archive')).rejects.toThrow('unsafe');
  } finally {await client?.close();await rm(root,{recursive:true,force:true});}
});
