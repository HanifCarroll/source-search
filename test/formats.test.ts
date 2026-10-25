import {test,expect} from 'bun:test';
import {stripHtml} from '../src/formats/html';
import {frontmatterFields} from '../src/formats/frontmatter';
import {whatsappStructuredText} from '../src/sources/local/whatsapp-content';
import {Writer} from 'protobufjs/minimal';
const option=(value:string)=>Writer.create().uint32(10).string(value).finish();
function poll(question:string,choices:string[]){const p=Writer.create().uint32(18).string(question);for(const choice of choices)p.uint32(26).bytes(option(choice));return Writer.create().uint32(66).bytes(p.finish()).finish();}
test('HTML decoding preserves words, table cells and entities without script content',()=>{
 const text=stripHtml('<p title="a > b">caf&eacute; &mdash; pi&ntilde;ata</p><script>secret()</script><style>secret{}</style><table><tr><td>Left</td><td>Right</td></tr></table><p>&#x110000;</p>');
 expect(text).toContain('café — piñata');expect(text).toMatch(/Left\s+Right/);expect(text).not.toContain('secret');expect(text).not.toContain('a > b');
});
test('YAML frontmatter respects complete delimiter lines and scalar types',()=>{
 expect(frontmatterFields('---\nsource_audio: "fixture://recording---part"\nsource: muesli\nmuesli_meeting_id: 123\ntags: [one, two]\n---\nBody').source_audio).toBe('fixture://recording---part');
 expect(frontmatterFields('---\nmodel: [not, scalar]\n---\nBody').model).toBeUndefined();
 expect(frontmatterFields('Text\n---\nsource: false')).toEqual({});
});
test('WhatsApp polls decode authored question and choices, ignoring receipt fields',()=>{
 expect(whatsappStructuredText({messageType:46,pollData:poll('Invented picnic?', ['Park','River'])})).toMatchObject({text:'Poll\nInvented picnic?\n- Park\n- River',origin:'poll'});
 expect(whatsappStructuredText({messageType:1,pollData:poll('Hidden',[])}).text).toBe('');
 expect(whatsappStructuredText({messageType:46,pollData:new Uint8Array([66,255])}).warning).toBeTruthy();
});
test('WhatsApp vCard3 contact details exclude binary photos and overloaded media fields',()=>{
 const card='BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nTEL;TYPE=CELL:+15550102030\r\nEMAIL:jane@example.test\r\nORG:Example;Research\r\nPHOTO;ENCODING=b:SGVsbG8=\r\nEND:VCARD';
 const result=whatsappStructuredText({messageType:4,contactCard:card});
 expect(result.text).toContain('Jane Doe');expect(result.text).toContain('+15550102030');expect(result.text).toContain('jane@example.test');expect(result.text).not.toContain('SGVsbG8');
 expect(whatsappStructuredText({messageType:1,contactCard:card}).text).toBe('');
});

import {parseMimeMessage} from '../src/formats/mime';
import {parseCalendarComponent,calendarDate} from '../src/formats/calendar';
test('MIME decodes charsets and quoted senders and drains attachment data',async()=>{
 const text='From: "Doe, Jane" <jane@example.test>\r\nSubject: =?ISO-8859-1?Q?caf=E9?=\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=ISO-8859-1\r\n\r\ncaf\xe9\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=x.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.alloc(1024*1024,42).toString('base64')+'\r\n--fixture--';
 const result=await parseMimeMessage(Buffer.from(text,'latin1'));
 expect(result.subject).toBe('café');expect(result.bodyText.trim()).toBe('café');expect(result.participants).toEqual([{id:'jane@example.test',displayName:'Doe, Jane',role:'author'}]);
});
const date=(line:string,zone='')=>calendarDate(parseCalendarComponent(`BEGIN:VCALENDAR\r\n${zone}BEGIN:VEVENT\r\nUID:fixture\r\n${line}\r\nEND:VEVENT\r\nEND:VCALENDAR`).getFirstSubcomponent('vevent')!.getFirstProperty('dtstart'));
const zone=(offset:string)=>`BEGIN:VTIMEZONE\r\nTZID:Fixture/Offset\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:${offset}\r\nTZOFFSETTO:${offset}\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n`;
test('calendar resolves embedded and IANA zones without changing floating or all-day dates',()=>{
 expect(date('DTSTART;TZID=Fixture/Offset:20240101T100000',zone('+0230'))?.date?.toISOString()).toBe('2024-01-01T07:30:00.000Z');
 expect(date('DTSTART;TZID=Fixture/Offset:20240101T100000',zone('-0400'))?.date?.toISOString()).toBe('2024-01-01T14:00:00.000Z');
 expect(date('DTSTART;TZID=America/New_York:20240101T100000')?.date?.toISOString()).toBe('2024-01-01T15:00:00.000Z');
 expect(date('DTSTART;TZID=America/New_York:20240310T023000')?.date?.toISOString()).toBe('2024-03-10T07:30:00.000Z');
 expect(date('DTSTART;TZID=America/New_York:20241103T013000')?.date?.toISOString()).toBe('2024-11-03T05:30:00.000Z');
 expect(date('DTSTART:20240101T100000')?.date).toBeUndefined();expect(date('DTSTART;VALUE=DATE:20240101')?.metadata).toEqual({raw:'20240101',allDay:true});
 expect(date('DTSTART;TZID=Unknown/Place:20240101T100000')?.metadata.unresolvedTimezone).toBe(true);
});

import {ZipWriter,Uint8ArrayWriter,TextReader} from '@zip.js/zip.js';
import {parseSafeZipArchive,loadSafeZipArchive} from '../src/vendor/takeout/zip';
import {createZip} from './helpers/zip';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('ZIP64 retains hashes and repeatable reads; damaged payload CRC and duplicate/symlink entries fail',async()=>{
 const writer=new ZipWriter(new Uint8ArrayWriter(),{zip64:true,useWebWorkers:false});await writer.add('fixture.txt',new TextReader('Fixture ZIP64'));
 const bytes=await writer.close(),zip=await parseSafeZipArchive(bytes);
 expect(zip.archiveSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
 for(let i=0;i<2;i++)expect(new TextDecoder().decode(await zip.readEntry(zip.entries[0]!))).toBe('Fixture ZIP64');
 await expect(parseSafeZipArchive(await createZip([{path:'x',text:'one'},{path:'x',text:'two'}]))).rejects.toThrow();
 await expect(parseSafeZipArchive(await createZip([{path:'link',text:'target',externalAttributes:0xa1ff0000}]))).rejects.toThrow('symbolic-link');
 const damaged=await createZip([{path:'fixture.txt',text:'Original'}]);damaged[41]^=1;
 const bad=await parseSafeZipArchive(damaged);await expect(bad.readEntry(bad.entries[0]!)).rejects.toThrow();
});
test('ZIP limits, file streaming and source changes are enforced',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-zip-'));
 try{
  const bytes=await createZip([{path:'a',text:'abc'},{path:'b',text:'def'}]);
  for(const options of [{maxEntries:1},{maxTotalUncompressedBytes:5},{maxArchiveBytes:10}])await expect(parseSafeZipArchive(bytes,options)).rejects.toThrow('safety limit');
  await expect(parseSafeZipArchive(await createZip([{path:'bomb',text:'a'.repeat(10000),method:8}]),{maxCompressionRatio:2})).rejects.toThrow('ratio');
  const path=join(root,'archive.zip');await writeFile(path,bytes);const zip=await loadSafeZipArchive(path);
  const memory=await parseSafeZipArchive(bytes);
  for(const archive of [zip,memory])expect(archive.entries[0]!.compressedSha256).toBe(createHash('sha256').update('abc').digest('hex'));
  expect(new TextDecoder().decode(await zip.readEntry(zip.entries[0]!))).toBe('abc');
  await writeFile(path,await createZip([{path:'changed',text:'other'}]));await expect(zip.readEntry(zip.entries[0]!)).rejects.toThrow('changed');
  await symlink(path,join(root,'link.zip'));await expect(loadSafeZipArchive(join(root,'link.zip'))).rejects.toThrow('symbolic link');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('WhatsApp concatenated vCards and legacy malformed photo fields retain contact text',()=>{
 const card='BEGIN:VCARD\nVERSION:3.0\nFN:Fixture Person\nInvented second line\nitem1.TEL;TYPE=CELL:+15550102030\nPHOTO;BASE64:binary\nUnfoldedPhotoBytes\nEND:VCARD';
 const next='BEGIN:VCARD\nVERSION:3.0\nFN:Second Person\nEMAIL:second@example.test\nEND:VCARD';
 const result=whatsappStructuredText({messageType:4,contactCard:card+'\n'+next});
 expect(result.text).toContain('Fixture Person\nInvented second line');expect(result.text).toContain('+15550102030');expect(result.text).toContain('Second Person');expect(result.text).not.toContain('UnfoldedPhotoBytes');expect(result.warning).toBeUndefined();
});

test('large file-backed ZIP slice hashing completes without a Bun stream stall',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ss-zip-stream-'));
 try{
  const path=join(root,'archive.zip'),script=join(root,'check.ts');
  const bytes=await createZip([{path:'large.txt',text:'x'.repeat(32*1024*1024)},{path:'second.txt',text:'y'.repeat(32*1024*1024)}]);await writeFile(path,bytes);
  await writeFile(script,`import {loadSafeZipArchive} from ${JSON.stringify(join(import.meta.dir,'../src/vendor/takeout/zip.ts'))};const zip=await loadSafeZipArchive(${JSON.stringify(path)});if((await zip.readEntry(zip.entries[0])).length!==32*1024*1024)throw Error('size mismatch');`);
  const child=Bun.spawn([process.execPath,script],{stdout:'pipe',stderr:'pipe',timeout:5000});expect(await child.exited).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
},10000);

test('optional ZIP64 footers without legacy sentinel fields remain strict and preserve original hashes',async()=>{
 const writer=new ZipWriter(new Uint8ArrayWriter(),{zip64:true,useWebWorkers:false});await writer.add('fixture.txt',new TextReader('Optional ZIP64 footer'));
 const bytes=await writer.close(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=bytes.length-22,footer=end-76;
 view.setUint16(end+4,0,true);view.setUint16(end+6,0,true);view.setUint16(end+8,Number(view.getBigUint64(footer+24,true)),true);view.setUint16(end+10,Number(view.getBigUint64(footer+32,true)),true);view.setUint32(end+12,Number(view.getBigUint64(footer+40,true)),true);view.setUint32(end+16,Number(view.getBigUint64(footer+48,true)),true);
 const zip=await parseSafeZipArchive(bytes);expect(new TextDecoder().decode(await zip.readEntry(zip.entries[0]!))).toBe('Optional ZIP64 footer');expect(zip.archiveSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
 for(const offset of [end+10,end+12,end+16,footer+16,footer+64]){const bad=bytes.slice();bad[offset]^=1;await expect(parseSafeZipArchive(bad)).rejects.toThrow();}
});

import {parseTakeoutEntry} from '../src/vendor/takeout/parsers';
test('Takeout HTML preserves flat revisions and dates after nested content',async()=>{
  const context={archiveSha256:'a'.repeat(64),archiveBytes:1000,importedAt:new Date('2024-01-02T00:00:00Z'),sourceAccountId:'fixture',entrySha256:'b'.repeat(64),
    entry:{path:'Takeout/YouTube/history/watch-history.html',entryId:'fixture',isDirectory:false,compressedSize:100,uncompressedSize:100,compressionMethod:0 as const,crc32:0,flags:0,externalAttributes:0,localHeaderOffset:0,compressedSha256:'c'.repeat(64)}};
  const link='<a href="https://www.youtube.com/watch?v=fixture&amp;list=sample">Fixture &amp; video</a>';
  const parse=(inside:string)=>parseTakeoutEntry({kind:'youtube-html',entry:context.entry},new TextEncoder().encode('<div class="content-cell">'+inside+'</div>'),context);
  const flat=await parse('Watched '+link+'<br>Jan 1, 2024, 12:00:00 AM UTC');
  const nested=await parse('Watched <div>'+link+'</div><br>Jan 1, 2024, 12:00:00 AM UTC');
  expect(flat.items).toHaveLength(1);expect(nested.items).toHaveLength(1);
  expect(flat.items[0]!.revisionId).toBe('1df954f41f141c1997df395a46321015e06fefa80ce22d387b294851ae8e0263');
  expect(new Date(nested.items[0]!.occurredAt!).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  expect(nested.items[0]!.sourceItemId).toBe(flat.items[0]!.sourceItemId);
  expect(nested.items[0]!.title).toBe('Fixture & video');
  expect(nested.items[0]!.contentText).toContain('watch?v=fixture&list=sample');
  // HTML source stays verbatim, including entity spelling, rather than DOM serialization.
  expect(JSON.stringify(flat.items[0]!.rawCapture!.raw)).toContain('amp;list');
});
