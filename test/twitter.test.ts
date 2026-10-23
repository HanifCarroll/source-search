import {test,expect} from "bun:test";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {twitterRecords,parseTwitterData,twitterCategory,twitterCatalogue,twitterSearchableEntry} from "../src/sources/archives/twitter";
import {parseSafeZipArchive} from "../src/vendor/takeout/zip";
import {createZip} from "./helpers/zip";
import {describeSource} from "../src/application/catalogue";
import {defaultConfig} from "./helpers/config";
import {rebuildArchive,indexStatus} from "../src/sources/archives/index";
import {createRuntime} from "../src/application/runtime";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
const wrap=(key:string,rows:unknown[])=>`window.YTD.${key}.part0 = ${JSON.stringify(rows)};`;
const posts=[{tweet:{id_str:"1001",full_text:"Fixture architecture in Buenos Aires 🇦🇷",created_at:"Wed Jan 03 10:00:00 +0000 2024",extended_entities:{media:[{type:"photo",media_url:"https://example.test/fixture.jpg",extra:"x".repeat(50000)}]}}},{tweet:{id_str:"1002",full_text:"RT @fixture: Quoted architecture",created_at:"Thu Jan 04 10:00:00 +0000 2024"}},{tweet:{id_str:"1003",full_text:"Fixture reply architecture",in_reply_to_status_id_str:"1001",created_at:"Fri Jan 05 10:00:00 +0000 2024"}}];
const longPosts=[{noteTweet:{noteTweetId:"4001",createdAt:"2025-01-02T00:00:00Z",core:{text:"Full-length fixture longpost evidence"}}}];
const articles=[{article:{id:"5001",title:"Fixture article",content:{blocks:[{text:"First article passage"},{text:"Second article passage"}]}}}];
const grok=[{grokChatItem:{chatId:"fixture-chat",createdAt:"2025-01-03T00:00:00Z",sender:{name:"User",value:"1"},message:"Fixture personal prompt"}},{grokChatItem:{chatId:"fixture-chat",createdAt:"2025-01-03T00:01:00Z",sender:{name:"Agent",value:"2"},message:"Fixture generated answer"}}];
const encrypted=[{messageEvent:{messageId:"6001",senderId:"11",conversationId:"11-22",createdAtMsec:"1735948800000",detail:{messageCreateEvent:{contents:"ZW5jcnlwdGVkLWZpeHR1cmU="}}}}];
const dms=[{dmConversation:{conversationId:"11-22",messages:[{messageCreate:{id:"2001",senderId:"11",recipientId:"22",text:"Fixture architecture message",createdAt:"2024-01-04T10:00:00.000Z"}},{messageCreate:{id:"2002",senderId:"22",recipientId:"11",text:"Fixture answer",createdAt:"2024-01-05T10:00:00.000Z"}}]}}];
test("X parser never executes JS; preserves exact prose, dates, provenance and attribution",()=>{
 expect(parseTwitterData(wrap("tweets",[]),"data/tweets.js")).toEqual([]);
 for(const text of ['window.YTD.tweets.part0 = []; process.exit(1);','window.YTD.tweets.part0 = [{tweet: {}}];','{"tweet":[]}'])expect(()=>parseTwitterData(text,"data/tweets.js")).toThrow();
 expect(twitterCategory("twitter-export/data/tweets-part1.js")).toBe("tweets");
 expect(parseTwitterData('window.__THAR_CONFIG = {"archiveInfo":{"isPartialArchive":false}};',"data/manifest.js")).toHaveLength(1);
 expect(twitterCategory("assets/js/main.js")).toBeUndefined();
 const r=twitterRecords(wrap("tweets",posts),"/fixture.zip","data/tweets.js",0).records;
 expect(r[0].body).toBe(posts[0].tweet.full_text);expect(r[0].occurredAt).toBe("2024-01-03T10:00:00.000Z");
 expect(r[0].metadata?.url).toBe("https://x.com/i/web/status/1001");expect(r[1].sections?.[0].kind).toBe("quoted");expect(r[1].metadata?.authorship).toBe("reposted-content");expect(r[2].metadata?.replyTo).toBe("1001");
 expect(()=>twitterRecords(wrap("tweets",[{tweet:{id_str:"1"}}]),"/fixture.zip","data/tweets.js",0)).toThrow("ID/text");
 const like=twitterRecords(wrap("like",[{like:{tweetId:"3001",fullText:"Someone else's fixture",expandedUrl:"https://evil.test"}}]),"/fixture.zip","data/like.js",0).records[0];
 expect(like.occurredAt).toBeUndefined();expect(like.sections?.[0].kind).toBe("quoted");expect(like.metadata?.url).toBe("https://x.com/i/web/status/3001");
 const metadata=twitterRecords(wrap("profile",[{profile:{description:{bio:"Fixture biography"}}}]),"/fixture.zip","data/profile.js",0).records[0];expect(metadata.sections?.[0].kind).toBe("metadata");expect(metadata.body).toContain("Fixture biography");
});

test("X archive runtime searches, paginates, opens originals/context and refuses stale/malformed replacements",async()=>{
 const root=await mkdtemp(join(tmpdir(),"source-search-x-"));
 try{
  const things=join(root,"things");await mkdir(things);
  for(const [name,text] of Object.entries({"tasks.jsonl":"","context.json":'{"TMTask":[]}',"snapshot-info.json":'{"taskCount":0,"exportedAt":"2024-01-01T00:00:00Z"}'}))await writeFile(join(things,name),text);
  const zip=join(root,"twitter.zip"),bytes=await createZip([{path:"export/data/note-tweet.js",text:wrap("note_tweet",longPosts)},{path:"export/data/article.js",text:wrap("article",articles)},{path:"export/data/grok-chat-item.js",text:wrap("grok_chat_item",grok)},{path:"export/data/message-event.js",text:wrap("message_event",encrypted)},{path:"export/data/manifest.js",text:'window.__THAR_CONFIG = {"archiveInfo":{"isPartialArchive":false},"dataTypes":{"tweets":{"files":[{"fileName":"data/tweets.js"}]}}};'},{path:"export/data/tweets.js",text:wrap("tweets",posts)},{path:"export/data/direct-messages.js",text:wrap("direct_messages",dms)},{path:"export/data/like.js",text:wrap("like",[])},{path:"export/data/profile.js",text:wrap("profile",[{profile:{description:{bio:"Fixture biography"},extra:"x".repeat(50000)}}])},{path:"export/data/tweets_media/1001.jpg",text:"fixture image"},{path:"export/Your archive.html",text:"viewer"}]);
  await writeFile(zip,bytes);const c={...defaultConfig(),things,index:join(root,"index.sqlite"),twitter:[zip]},rt=createRuntime(c);
  await rebuildArchive(c);const status=JSON.parse((await indexStatus(c))["twitter-archive"]);expect(status.count).toBe(9);expect(status.dateCoverage).toEqual({datedRecords:8,undatedRecords:1});expect(status.categories.some((v:any)=>v.recordType==="twitter-like" && v.records===0)).toBe(true);
  const first=(await rt.search_sources({queries:[{source:"twitter-archive",query:"architecture",types:["twitter-post"],sort:"oldest",limit:1}]})).results[0];expect(first.items[0].metadata?.openLink).toBe("https://x.com/i/web/status/1001");expect(first.nextCursor).toBeDefined();
  const second=(await rt.search_sources({queries:[{source:"twitter-archive",query:"architecture",types:["twitter-post"],sort:"oldest",limit:1,cursor:first.nextCursor}]})).results[0];expect(second.items[0].ref.id).not.toBe(first.items[0].ref.id);expect(second.items[0].match.section).toBe("quoted");
  const primary=(await rt.search_sources({queries:[{source:"twitter-archive",query:"architecture",types:["twitter-post"],sections:["primary"]}]})).results[0];expect(primary.items).toHaveLength(2);
  const read=await rt.read_record({ref:first.items[0].ref,focus:first.items[0].focus});expect(read.record.body).toBe(posts[0].tweet.full_text);expect(read.record.metadata?.originalRecord).toBeUndefined();
  const details=await rt.read_record({ref:first.items[0].ref,details:true});expect(details.record.body).toContain('"extended_entities"');
  const messages=(await rt.search_sources({queries:[{source:"twitter-archive",query:"architecture",types:["twitter-message"],conversation:"11-22"}]})).results[0];const context=await rt.read_record({ref:messages.items[0].ref,context:true});expect(context.record.author).toBe("11");expect(context.context).toHaveLength(1);expect((context.context[0] as any).author).toBe("22");
  const profile=(await rt.search_sources({queries:[{source:"twitter-archive",query:"biography",sections:["metadata"]}]})).results[0];expect(profile.items).toHaveLength(0);const long=await rt.read_record({ref:first.items[0].ref,details:true});expect(long.record.nextCursor).toBeDefined();
  const date=(await rt.search_sources({queries:[{source:"twitter-archive",query:"",from:"2024-01-04T00:00:00Z",to:"2024-01-05T00:00:00Z"}]})).results[0];expect(date.items).toHaveLength(2);expect(date.sourceWarnings?.some(w=>w.includes("1 otherwise matching"))).toBe(true);
  for(const [query,type,expected] of [["longpost","twitter-long-post","Full-length fixture longpost evidence"],["Second article passage","twitter-article","Fixture article\n\nFirst article passage\n\nSecond article passage"],["personal prompt","twitter-grok-message","Fixture personal prompt"]]){
   const page=(await rt.search_sources({queries:[{source:"twitter-archive",query,types:[type],sections:["primary"]}]})).results[0];expect(page.items).toHaveLength(1);expect((await rt.read_record({ref:page.items[0].ref})).record.body).toBe(expected);
  }
  const generated=(await rt.search_sources({queries:[{source:"twitter-archive",query:"generated answer",sections:["primary"]}]})).results[0];expect(generated.items).toHaveLength(0);
  const grokPage=(await rt.search_sources({queries:[{source:"twitter-archive",query:"personal prompt",conversation:"grok:fixture-chat"}]})).results[0];expect((await rt.read_record({ref:grokPage.items[0].ref,context:true})).context).toHaveLength(1);
  const encryptedPage=(await rt.search_sources({queries:[{source:"twitter-archive",query:"",types:["twitter-message-event"],from:"2025-01-01T00:00:00Z"}]})).results[0];expect(encryptedPage.items).toHaveLength(0);expect(encryptedPage.error?.code).toBe("TYPE_NOT_AVAILABLE");
  const excluded=twitterRecords(wrap("profile",[{profile:{description:{bio:"Fixture biography"}}}]),zip,"export/data/profile.js",0).records[0]!;
  await expect(rt.read_record({ref:excluded.ref})).rejects.toThrow("Record is absent");
  expect(await readFile(zip)).toEqual(Buffer.from(bytes));
  // Test the same real MCP gateway used by connected clients, with invented data only.
  const config=join(root,"config.json");await writeFile(config,JSON.stringify(c));
  const transport=new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,"../src/mcp.ts")],env:{...process.env,SOURCE_SEARCH_CONFIG_FILE:config} as Record<string,string>,stderr:"pipe"});const client=new Client({name:"fixture-x",version:"1"});
  try{await client.connect(transport);const result=await client.callTool({name:"search_sources",arguments:{queries:[{source:"twitter-archive",query:"architecture",types:["twitter-post"]}]}});expect(result.isError).not.toBe(true);expect(JSON.parse((result.content as any)[0].text).results[0].items).toHaveLength(3);}finally{await client.close();}
  await writeFile(zip,await createZip([{path:"data/tweets.js",text:"window.YTD.tweets.part0 = process.exit(1)"}]));
  const stale=(await rt.search_sources({queries:[{source:"twitter-archive",query:"architecture"}]})).results[0];expect(stale.error?.code).toBe("INDEX_STALE");
  const oldIndex=await readFile(c.index);await expect(rebuildArchive(c)).rejects.toThrow("Malformed X");expect(await readFile(c.index)).toEqual(oldIndex);
  await writeFile(zip,await createZip([{path:"data/manifest.js",text:'window.__THAR_CONFIG = {"dataTypes":{"tweets":{"files":[{"fileName":"data/tweets-part1.js"}]}}};'},{path:"data/tweets.js",text:wrap("tweets",posts)}]));
  await expect(rebuildArchive(c)).rejects.toThrow("missing data files");expect(await readFile(c.index)).toEqual(oldIndex);
 }finally{await rm(root,{recursive:true,force:true});}
});


test("native X ZIP directory variants accept empty deflate but retain path, data and CRC checks",async()=>{
 const archive=await parseSafeZipArchive(await createZip([{path:"data/",text:"",method:8},{path:"assets//",text:"",method:8}]));
 expect(archive.entries.every(e=>e.isDirectory)).toBe(true);expect(await archive.readEntry(archive.entries[0]!)).toHaveLength(0);
 const bad=await createZip([{path:"data/",text:"not empty",method:8}]);await expect(parseSafeZipArchive(bad)).rejects.toThrow("file data");
 const bytes=await createZip([{path:"data/",text:"",method:8}]);const corrupted=new Uint8Array(bytes);corrupted[35]=255;await expect(parseSafeZipArchive(corrupted)).rejects.toThrow();
 for(const path of ["../data/","assets/../","assets//images/","/data/"]){const bytes=await createZip([{path,text:"",method:8}]);await expect(parseSafeZipArchive(bytes)).rejects.toThrow(/unsafe/i);}
});


test("X catalogue keeps populated counts and empty filters without repeating entry paths",()=>{
 const categories=twitterCatalogue([{entry:"data/tweets.js",records:2,recordType:"twitter-post"},{entry:"data/community-tweet.js",records:1,recordType:"twitter-post"},{entry:"data/like.js",records:0,recordType:"twitter-like"}]);
 expect((describeSource(defaultConfig(),{source:"twitter-archive",available:true,index:{recordTypes:["twitter-account","twitter-post"]}}).example as {types?:string[]}).types).toEqual(["twitter-post"]);
 expect(categories.categories).toEqual([{recordType:"twitter-post",records:3}]);expect(categories.emptyRecordTypes).toEqual(["twitter-like"]);expect(categories.categoryEntries).toBe(3);
});


test("X search selection keeps content files and excludes account/admin metadata",()=>{
 for(const entry of ["tweets","community-tweet","note-tweet","article","like","direct-messages","direct-messages-group","grok-chat-item"])expect(twitterSearchableEntry("data/"+entry+".js")).toBe(true);
 for(const entry of ["manifest","profile","account","device-token","message-event","tweet-headers","article-metadata","ip-audit","follower","ad-impressions"])expect(twitterSearchableEntry("data/"+entry+".js")).toBe(false);
});
