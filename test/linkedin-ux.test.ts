import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createZip} from './helpers/zip';
import {defaultConfig} from './helpers/config';
import {rebuildArchive} from '../src/archive';
import {createRuntime} from '../src/runtime';
import {linkedInRecords} from '../src/linkedin';
import {findRecordMatch} from '../src/content';
import {matchesQuery} from '../src/query';
import {compactRecord} from '../src/presentation';
import {hit,querySchema} from '../src/shared';

const csv=(rows:string[][])=>rows.map(r=>r.map(v=>'"'+v.replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
test('LinkedIn projection retains original fields while presenting content, peers, attachments and calendar days',()=>{
 const links='https://www.linkedin.com/dms/prv/document/pl/v2/fixture/messaging-document-images-480/x?m=fixture-token,https://www.linkedin.com/dms/prv/document/media/v2/fixture/messaging-document-pdf-analyzed/x?t=fixture-token';
 const records=linkedInRecords(csv([['FROM','TO','DATE','CONTENT','SENDER PROFILE URL','ATTACHMENTS'],['Alex','Taylor','2024-02-29 12:30:00','Fixture message','https://www.linkedin.com/in/fixture',links],['Alex','Taylor','2024-02-30 12:30:00','','',links]]),'/fixture.zip','messages.csv',0);
 const r=records[0];expect(r.title).toContain('Alex → Taylor');expect(r.title).toContain('Fixture message');expect(r.occurredAt).toBe('2024-02-29T00:00:00.000Z');expect(r.metadata?.timezone).toBe('unspecified');expect(r.metadata?.sourceDate).toBe('2024-02-29 12:30:00');expect(records[1].occurredAt).toBeUndefined();
 expect(findRecordMatch(r,{query:'Sender Profile',sections:['primary']})).toBeUndefined();expect(findRecordMatch(r,{query:'Sender Profile',sections:['metadata']})).toBeDefined();expect(findRecordMatch(r,{query:'linkedin'})).toBeUndefined();
 expect(r.metadata?.attachments).toEqual({count:1,kinds:['document'],contentsIndexed:false});expect(r.body).not.toContain('fixture-token');expect(compactRecord(r).metadata?.originalFields).toBeUndefined();expect(compactRecord(r,true).metadata?.originalFields).toContainEqual({name:'ATTACHMENTS',value:links});
 const nameHit=hit(r,querySchema.parse({source:'linkedin-archive',query:'Alex Taylor'}),1);expect(nameHit.excerpt).toBe('Fixture message');
 const attachmentHit=hit(records[1],querySchema.parse({source:'linkedin-archive',query:''}),2);expect(attachmentHit.metadata?.bodyStatus).toBe('attachment-only');expect(attachmentHit.excerpt).toContain('Attachment-only');expect(attachmentHit.metadata?.openAction).toContain('preview:true');
 const app=linkedInRecords(csv([['Job Title','Company Name','Application Date','Job Url'],['Engineer','Fixture Corp','2/29/24, 2:10 PM','http://www.linkedin.com/jobs/view/123']]),'/fixture.zip','Jobs/Job Applications.csv',0)[0];expect(app.title).toBe('Engineer at Fixture Corp');expect(app.occurredAt).toBe('2024-02-29T00:00:00.000Z');expect(app.metadata?.url).toBe('https://www.linkedin.com/jobs/view/123');
 expect(linkedInRecords(csv([['Job Title','Job Url'],['Engineer','https://linkedin.com.attacker.test/jobs/123']]),'/fixture.zip','Jobs/Job Applications.csv',0)[0].metadata?.url).toBeUndefined();
 const recommendation=linkedInRecords(csv([['First Name','Last Name','Company','Job Title','Text'],['Alex','Fixture','Fixture Co','Manager','Thoughtful engineering']]),'/fixture.zip','Recommendations_Received.csv',0)[0];expect(recommendation.title).toBe('Recommendation from Alex Fixture at Fixture Co');
 const connection=linkedInRecords(csv([['First Name','Last Name','Connected On'],['Alex','Fixture','1 Jan 2024']]),'/fixture.zip','Connections.csv',0)[0];expect(findRecordMatch(connection,{query:'2024',sections:['primary']})).toBeUndefined();expect(findRecordMatch(connection,{query:'2024',sections:['metadata']})).toBeDefined();
 const raw='First line."\n""\n"Second line."',post=linkedInRecords(csv([['Date','ShareCommentary'],['2024-01-02 12:34:56',raw]]),'/fixture.zip','Shares_123.csv',0)[0];expect(post.title).toBe('First line.');expect(post.body).toContain('First line.\n\nSecond line.');expect(post.metadata?.originalFields).toContainEqual({name:'ShareCommentary',value:raw});
 expect(linkedInRecords(csv([['ShareCommentary'],['She said "hello".']]),'/fixture.zip','Shares_123.csv',0)[0].body).toContain('She said "hello".');
});

test('technical query tokens keep punctuation and exact original focus',()=>{
 expect(matchesQuery('CSS Consulting Communication',{query:'C++'})).toBe(false);expect(matchesQuery('C++ engineer',{query:'C++'})).toBe(true);expect(matchesQuery('Netlify',{query:'.NET'})).toBe(false);expect(matchesQuery('.NET developer',{query:'.NET'})).toBe(true);
 const r=linkedInRecords(csv([['Name'],['C++']]),'/fixture.zip','Skills.csv',0)[0],match=findRecordMatch(r,{query:'C++'});expect(match?.start).toBeDefined();expect(r.body.slice(match!.start,match!.end)).toBe('C++');
});

test('LinkedIn shared search groups repeats, keeps occurrence pagination, supplies context and handles empty/date scopes honestly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'source-search-linkedin-ux-'));
 try {
  const things=join(root,'things');await mkdir(things);for(const [name,body] of Object.entries({'tasks.jsonl':'','context.json':'{"TMTask":[]}','snapshot-info.json':'{"taskCount":0,"exportedAt":"2024-01-01T00:00:00Z"}'}))await writeFile(join(things,name),body);
  const messageRows=[['CONVERSATION ID','FROM','TO','DATE','CONTENT'],...Array.from({length:15},(_,i)=>['thread-fixture',i%2?'Taylor':'Alex',i%2?'Alex':'Taylor',`2024-01-${String(i+1).padStart(2,'0')} 12:00:00 UTC`,`Engineer fixture ${i}`]),['other-thread','Alex','Other','2024-01-10 12:00:00 UTC','Do not mix this conversation']];
  const zip=join(root,'linkedin.zip'),bytes=await createZip([
   {path:'messages.csv',text:csv(messageRows)},
   {path:'SearchQueries.csv',text:'Time,Search Query\n2024/01/01 12:00:00 UTC,engineer\n2024/01/02 12:00:00 UTC,engineer\n2024/01/03 12:00:00 UTC,designer\n'},
   {path:'Shares_123.csv',text:csv([['Date','ShareCommentary'],['2024-01-01 11:00:00','First fixture'],['2024-02-01 11:00:00','Second fixture']])},
   {path:'Jobs/Job Applications.csv',text:csv([['Application Date','Job Title','Company Name'],['2/1/24, 3:00 AM','Engineer','Fixture Co']])},
   {path:'Skills.csv',text:csv([['Name'],['CSS'],['C++'],['Netlify'],['.NET']])},
   {path:'Logins.csv',text:csv([['Login Date','IP Address'],['2024-01-01 12:00:00 UTC','192.0.2.1']])},
   {path:'Notes.csv',text:'Note\n'},{path:'Profile.csv',text:'First Name\nFixture\n'}]);
  await writeFile(zip,bytes);const config={...defaultConfig(),things,index:join(root,'index.sqlite'),linkedin:[zip]};await rebuildArchive(config);const runtime=createRuntime(config);
  const search=async(q:any)=>(await runtime.search_sources({queries:[{source:'linkedin-archive',query:'',...q}]})).results[0];
  const oldest=await search({types:['posts'],sort:'oldest'}),newest=await search({types:['posts'],sort:'newest'});expect(oldest.items[0].title).toBe('First fixture');expect(newest.items[0].title).toBe('Second fixture');expect(oldest.status).toBe('ok');
  const window=await search({types:['posts'],from:'2024-02-01T12:00:00Z',to:'2024-02-02T00:00:00Z'});expect(window.items).toHaveLength(1);expect(window.items[0].title).toBe('Second fixture');
  expect((await search({types:['applications'],from:'2024-01-01T00:00:00Z',to:'2025-01-01T00:00:00Z'})).items).toHaveLength(1);
  // Account and search-log categories stay in the original ZIP.
  for(const type of ['search history','Logins'])expect((await search({types:[type]})).error?.code).toBe('TYPE_NOT_AVAILABLE');
  const broad=await search({query:'engineer',limit:2});expect(broad.items.every(h=>h.type!=='linkedin-searchqueries')).toBe(true);
  expect((await search({types:['messages'],query:'Sender Profile',sections:['primary']})).items).toHaveLength(0);
  const thread=await search({types:['messages'],conversation:'thread-fixture',sort:'oldest',limit:25});const current=thread.items[7];const context=await runtime.read_record({ref:current.ref,context:true});expect(context.context).toHaveLength(10);expect(context.context.every((r:any)=>r.conversation==='thread-fixture' && r.ref.id!==current.ref.id)).toBe(true);expect(context.contextWarnings[0]).toContain('five');
  expect((await search({types:['skills'],query:'C++'})).items.map(h=>h.title)).toEqual(['C++']);expect((await search({types:['skills'],query:'.NET'})).items.map(h=>h.title)).toEqual(['.NET']);
  const empty=await search({types:['Notes']});expect(empty.status).toBe('ok');expect(empty.warnings[0]).toContain('no exported records');expect(empty.warnings.some(w=>w.includes('shorter word'))).toBe(false);
  const undated=await search({types:['Profile'],from:'2024-01-01T00:00:00Z'});expect(undated.warnings[0]).toContain('omit from/to');expect(undated.warnings.some(w=>w.includes('wider date'))).toBe(false);
  expect((await search({types:['Profile'],sort:'oldest'})).query?.sort).toBe('source-order');
  expect((await search({types:['Profile'],query:'Fixture',sort:'relevance'})).query?.sort).toBe('relevance');
  expect((await search({types:['skills'],sort:'oldest'})).items.map(h=>h.title)).toEqual(['CSS','C++','Netlify','.NET']);
  const invalid=await search({types:['not-a-type']});expect(invalid.error?.message.length).toBeLessThan(500);expect(invalid.error?.message).toContain('friendly names');expect(invalid.error?.message).not.toContain('missing installments');
  const original=await runtime.read_record({ref:current.ref,details:true});expect(original.record.metadata?.originalFields).toContainEqual({name:'CONTENT',value:'Engineer fixture 7'});
  expect(await readFile(zip)).toEqual(Buffer.from(bytes));
  const part=join(root,'part-two.zip');await writeFile(part,await createZip([{path:'messages.csv',text:csv([['CONVERSATION ID','FROM','TO','DATE','CONTENT'],['thread-fixture','Alex','Taylor','2024-01-16 12:00:00 UTC','Following message from part two']])}]));
  const multi={...config,linkedin:[zip,part]};await rebuildArchive(multi);const multiRuntime=createRuntime(multi),last=thread.items[14],multiContext=await multiRuntime.read_record({ref:last.ref,context:true});expect(multiContext.context.some((r:any)=>r.excerpt.includes('Following message from part two'))).toBe(true);
 } finally {await rm(root,{recursive:true,force:true});}
});
