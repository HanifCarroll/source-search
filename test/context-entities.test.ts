import {test,expect} from 'bun:test';
import {contextEntitiesSchema,matchEntities} from '../src/domain/context';
import {normalizeIdentifier} from '../src/domain/identifiers';
import {configSchema} from '../src/platform/config';
import {versioned} from '../src/domain/identity';
import type {RecordData} from '../src/domain/contracts';
import {mailIdentifiers} from '../src/formats/mail-identifiers';
import {parsePimText} from '../src/formats/pim';
import {eventRecord,contactRecord} from '../src/sources/pim/model';

const record=(changes:Partial<RecordData>={})=>versioned({ref:{source:'work',id:'1'},title:'Alex',body:'Alex works on Atlas. email other@example.org',type:'note',locator:'test:1',observedAt:'2026-01-01T00:00:00Z',...changes});
const people=()=>contextEntitiesSchema.parse({alex:{kind:'person',label:'Alex',identifiers:[{kind:'email',value:'alex@example.org'},{kind:'phone',value:'+44 20 7946 0958'},{kind:'person-id',value:'user-1',source:'work'}]}});

test('relationships require explicit identifiers or saved records; names and prose never merge people',()=>{
  const entities=people();
  expect(matchEntities(record(),entities).links).toEqual([]);
  expect(matchEntities(record({identifiers:[{kind:'email',value:'alex@EXAMPLE.ORG'}]}),entities).links[0]?.entity).toBe('alex');
  expect(matchEntities(record({identifiers:[{kind:'phone',value:'+442079460958'}]}),entities).links[0]?.entity).toBe('alex');
  expect(matchEntities(record({identifiers:[{kind:'person-id',value:'user-1'}]}),entities).links[0]?.entity).toBe('alex');
  expect(matchEntities(record({ref:{source:'home',id:'1'},identifiers:[{kind:'person-id',value:'user-1'}]}),entities).links).toEqual([]);
  expect(normalizeIdentifier('phone','020 7946 0958')).toBeUndefined();
  for(const value of ['Alex@example.org','a.lex@example.org','alex+tag@example.org'])expect(matchEntities(record({identifiers:[{kind:'email',value}]}),entities).links).toEqual([]);
});

test('shared identifiers are reported as ambiguous, not merged, and config removal undoes a mapping',()=>{
  const entities=people(),r=record({identifiers:[{kind:'email',value:'alex@example.org'}]});
  entities.other={...entities.alex!,label:'Someone else'};
  const result=matchEntities(r,entities);
  expect(result.links).toEqual([]);expect(result.ambiguous[0]?.entities).toEqual(['alex','other']);
  delete entities.other;expect(matchEntities(r,entities).links).toHaveLength(1);
  delete entities.alex;expect(matchEntities(r,entities).links).toHaveLength(0);
});

test('record mappings honor versions and task projects use source-scoped provider IDs',()=>{
  const r=record(),entities=contextEntitiesSchema.parse({atlas:{kind:'project',label:'Atlas',records:[r.ref],identifiers:[{kind:'project-id',source:'work',value:'p1'}]}});
  expect(matchEntities(r,entities).links[0]?.via).toBe('record');
  expect(matchEntities(record({body:'Changed'}),entities).links).toEqual([]);
  expect(matchEntities(record({ref:{source:'work',id:'task'},task:{status:'open',project:{id:'p1',name:'Atlas'}}}),entities).links[0]?.via).toBe('identifier');
  expect(matchEntities(record({ref:{source:'other',id:'task'},task:{status:'open',project:{id:'p1',name:'Atlas'}}}),entities).links).toEqual([]);
});

test('configuration rejects invalid links and saves bounded source-specific queries',()=>{
  expect(configSchema.parse({}).contextEntities).toEqual({});
  const project={kind:'project',label:'Atlas',people:['alex']};
  expect(()=>contextEntitiesSchema.parse({atlas:project})).toThrow('Related people');
  expect(()=>contextEntitiesSchema.parse({alex:{kind:'person',label:'Alex',identifiers:[{kind:'person-id',value:'1'}]}})).toThrow('source ID');
  expect(()=>contextEntitiesSchema.parse({alex:{kind:'person',label:'Alex',identifiers:[{kind:'email',value:'Alex'}]}})).toThrow();
  expect(()=>contextEntitiesSchema.parse({alex:{kind:'person',label:'Alex',identifiers:[{kind:'repository',source:'code',value:'org/repo'}]}})).toThrow();
  expect(()=>contextEntitiesSchema.parse({atlas:{...project,people:[],queries:[{source:'work',query:'Atlas',cursor:'old'}]}})).toThrow();
  expect(contextEntitiesSchema.parse({atlas:{...project,people:[],queries:[{source:'work',query:'',task:{projectId:'p1'}}]}}).atlas?.queries[0]?.task?.projectId).toBe('p1');
});

test('derived calendar/contact identifiers preserve saved versions',()=>{
  const event={id:'e1',title:'Review',start:'2026-01-01T10:00:00Z',end:'2026-01-01T11:00:00Z',calendar:'Work',attendees:['Alex']};
  const before=eventRecord('agenda','google',event),after=eventRecord('agenda','google',{...event,emails:['alex@example.org']});
  expect(after.ref).toEqual(before.ref);expect(after.identifiers).toEqual([{kind:'email',value:'alex@example.org'}]);
  const contact={id:'c1',name:'Alex',book:'Work',fields:['Email: alex@example.org']};
  expect(contactRecord('people','microsoft',{...contact,emails:['alex@example.org']}).ref).toEqual(contactRecord('people','microsoft',contact).ref);
});

test('mail identifiers parse address groups and quoted display names, never the message body',async()=>{
  const r=record({type:'email',author:'"Example, Alex" <alex@example.org>',metadata:{to:'Team: bob@example.org, "Casey" <casey@example.org>;',cc:['dana@example.org']}});
  const ids=await mailIdentifiers(r);
  expect(ids.map(v=>v.value)).toEqual(['alex@example.org','bob@example.org','casey@example.org','dana@example.org']);
  expect(versioned({...r,ref:{...r.ref},identifiers:ids}).ref.version).toBe(r.ref.version);
});

test('portable calendar and contact files expose only structured participant identifiers',()=>{
  const card='BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Alex\r\nEMAIL:alex@example.org\r\nTEL:+442079460958\r\nNOTE:other@example.org\r\nEND:VCARD';
  const c=parsePimText(card,{source:'people',path:'/invented/a.vcf',format:'vcard',timeZone:'UTC'}).records[0]!;
  expect(c.identifiers?.filter(v=>v.kind==='email')).toEqual([{kind:'email',value:'alex@example.org'}]);
  const calendar='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\nSUMMARY:Review\r\nATTENDEE;CN=Alex:mailto:alex@example.org\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const event=parsePimText(calendar,{source:'agenda',path:'/invented/a.ics',format:'ical',timeZone:'UTC',range:{from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z'}}).records[0]!;
  expect(event.identifiers).toEqual([{kind:'email',value:'alex@example.org'}]);
});
