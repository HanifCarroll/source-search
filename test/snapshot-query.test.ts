import {test,expect} from 'bun:test';
import {snapshotPage} from '../src/domain/snapshot-query';
import {snapshotCoverage} from '../src/domain/snapshots';
import {querySchema,type SnapshotCoverage} from '../src/domain/contracts';
import {eventRecord,contactRecord,timestamp,withinWindow} from '../src/sources/pim/model';
import {versioned} from '../src/domain/identity';
import {parsePimText} from '../src/formats/pim';

const coverage:SnapshotCoverage={kind:'synchronized-snapshot',asOf:'2026-10-24T00:00:00Z',description:'Selected fixture records',window:{from:'2026-01-01T00:00:00Z',to:'2027-01-01T00:00:00Z'}};
const event=(id:string,start:string,end:string)=>eventRecord('agenda','fixture',{id,title:'Invented '+id,start,end,calendar:'Lab'});

test('CalDAV and iCalendar expansion retain occurrences starting before the requested window',()=>{
  const text=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:overnight','DTSTART:20260307T230000Z','DTEND:20260308T020000Z','RRULE:FREQ=DAILY;COUNT=3','SUMMARY:Overnight fixture','END:VEVENT',
    'BEGIN:VEVENT','UID:all-day','DTSTART;VALUE=DATE:20260307','DTEND;VALUE=DATE:20260309','SUMMARY:Multi-day fixture','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const range={from:'2026-03-08T00:00:00Z',to:'2026-03-09T00:00:00Z'},options={source:'agenda',path:'/invented/agenda.ics',format:'ical' as const,timeZone:'UTC'};
  const {records}=parsePimText(text,{...options,range});expect(records).toHaveLength(3);
  const page=snapshotPage(records,querySchema.parse({source:'agenda',query:'',...range}),coverage);expect(page.totalMatches).toBe(3);
  for(const r of records){
    const original=parsePimText(text,{...options,range:{from:r.occurredAt!,to:new Date(Date.parse(r.occurredAt!)+1000).toISOString()}}).records.find(v=>v.ref.id===r.ref.id);
    expect(original?.ref).toEqual(r.ref);
  }
});

test('calendar ranges include overlaps with exclusive ends, instants, all-day events and DST transitions',()=>{
  const from=timestamp('2026-03-08','America/New_York'),to=timestamp('2026-03-09','America/New_York');
  expect((Date.parse(to)-Date.parse(from))/3600000).toBe(23);
  const records=[
    event('crossing','2026-03-07T10:00:00Z','2026-03-08T12:00:00Z'),
    {...event('all-day',from,to),metadata:{endedAt:to,allDay:true}},
    event('end-at-from','2026-03-07T10:00:00Z',from),
    event('start-at-to',to,'2026-03-09T12:00:00Z'),
    event('instant-at-from',from,from),event('instant-at-to',to,to),
    event('spanning','2026-03-07T10:00:00Z','2026-03-10T12:00:00Z'),
  ];
  const q=querySchema.parse({source:'agenda',query:'',from,to,sort:'oldest'}),page=snapshotPage(records,q,coverage);
  expect(page.items.map(r=>r.ref.id)).toEqual(['crossing','spanning','all-day','instant-at-from']);
  expect(page.totalMatches).toBe(4);expect(page.query?.dateMatch).toBe('overlap');expect(page.items[2]!.metadata?.allDay).toBe(true);expect(page.items[2]!.metadata?.endedAt).toBe(to);
  for(const r of records)expect(withinWindow(r.occurredAt,r.metadata?.endedAt,{from,to})).toBe(page.items.some(i=>i.ref.id===r.ref.id));
  expect(snapshotPage(records,{...q,from:undefined},coverage).totalMatches).toBe(5);
  expect(snapshotPage(records,{...q,to:undefined},coverage).totalMatches).toBe(6);
});

test('complete snapshot queries count late matches, paginate without gaps and survive provider reordering',()=>{
  const records=Array.from({length:6501},(_,i)=>versioned({ref:{source:'files',id:String(i).padStart(5,'0')},title:i>=6000?'Cobalt target':'Different',body:'Invented source text',type:'document',locator:'fixture:'+i,observedAt:'2026-10-01T00:00:00Z'}));
  const q=querySchema.parse({source:'files',query:'cobalt',limit:7}),first=snapshotPage(records,q,coverage);
  expect(first.totalMatches).toBe(501);expect(first.items).toHaveLength(7);expect(first.scan).toMatchObject({checked:6501,exhausted:true});
  expect(first.items[0]!.ref.id).toBe('06000');
  const reversed=records.toReversed().map(r=>({...r,observedAt:'2026-10-25T00:00:00Z'})),ids=first.items.map(r=>r.ref.id);
  let cursor=first.nextCursor;
  while(cursor){const page=snapshotPage(reversed,{...q,limit:25,cursor},{...coverage,asOf:'2026-10-25T00:00:00Z'});expect(page.totalMatches).toBe(501);ids.push(...page.items.map(r=>r.ref.id));cursor=page.nextCursor;}
  expect(new Set(ids).size).toBe(501);expect(ids.at(-1)).toBe('06500');
  // Packet-budget continuation can resume from any returned hit, not just a page boundary.
  expect(snapshotPage(records,{...q,cursor:first.items[0]!.cursorAfter},coverage).items[0]!.ref.id).toBe('06001');
  expect(()=>snapshotPage(records,{...q,query:'different',cursor:first.nextCursor},coverage)).toThrow('Cursor');
  expect(()=>snapshotPage(records.slice(1),{...q,cursor:first.nextCursor},coverage)).toThrow('Cursor');
  expect(()=>snapshotPage(records,{...q,cursor:first.nextCursor},{...coverage,window:{...coverage.window!,to:'2026-11-01T00:00:00Z'}})).toThrow('Cursor');
});

test('counts respect combined type, conversation, section and phrase filters, including empty results',()=>{
  const records=[
    versioned({ref:{source:'chat',id:'one'},title:'Reply',body:'Cobalt phrase\nmetadata',sections:[{kind:'primary',start:0,end:13},{kind:'metadata',start:14,end:22}],type:'message',conversation:'thread',occurredAt:'2026-10-24T12:00:00Z',observedAt:'2026-10-24T12:00:00Z',locator:'fixture:one'}),
    versioned({ref:{source:'chat',id:'two'},title:'Reply',body:'Cobalt phrase',type:'message',conversation:'other',occurredAt:'2026-10-24T12:00:00Z',observedAt:'2026-10-24T12:00:00Z',locator:'fixture:two'}),
  ];
  const q=querySchema.parse({source:'chat',query:'cobalt phrase',match:'phrase',sections:['primary'],types:['message'],conversation:'thread',from:'2026-10-24T00:00:00Z',to:'2026-10-25T00:00:00Z'});
  expect(snapshotPage(records,q,coverage).items.map(r=>r.ref.id)).toEqual(['one']);
  const empty=snapshotPage(records,{...q,sections:['metadata']},coverage);expect(empty.totalMatches).toBe(0);expect(empty.nextCursor).toBeUndefined();
});

test('snapshot coverage qualifies counts by selection, window, successful observation and later failure',()=>{
  const saved={version:1 as const,scope:'fixture',records:[contactRecord('people','fixture',{id:'p',name:'Invented Optician',book:'Lab',fields:['Email: optics@example.test']})],checkpoint:'one',coverage:'Selected address book',coverageWindow:undefined,strategy:'delta',warnings:[],checkedAt:'2026-10-20T00:00:00Z',lastAttemptAt:'2026-10-24T00:00:00Z',lastError:{code:'OFFLINE',message:'Fixture offline'}};
  const q=querySchema.parse({source:'people',query:'optics@example.test',match:'phrase',sort:'relevance'}),page=snapshotPage(saved.records,q,snapshotCoverage(saved));
  expect(page.totalMatches).toBe(1);expect(page.status).toBe('partial');expect(page.coverage).toMatchObject({asOf:saved.checkedAt,syncedAt:saved.checkedAt,lastAttemptAt:saved.lastAttemptAt,lastError:saved.lastError});expect(page.items[0]!.metadata?.addressBook).toBe('Lab');
  const outside=snapshotPage([],querySchema.parse({source:'agenda',query:'',from:'2025-01-01T00:00:00Z'}),coverage);
  expect(outside.totalMatches).toBe(0);expect(outside.status).toBe('partial');expect(outside.warnings[0]).toContain('widen the configured window');expect(outside.coverage?.window).toEqual(coverage.window);
});
