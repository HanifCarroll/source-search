import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {configSchema} from '../src/platform/config';
import {createRuntime} from '../src/application/runtime';
import {syncSources} from '../src/maintenance/sources';

test('a portable independent setup prepares meetings and resumes projects through CLI and MCP without models',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ss-context-'));let client:Client|undefined;
  try {
    const notes=join(root,'Notes'),calendar=join(root,'agenda.ics'),contacts=join(root,'people.vcf'),tasks=join(root,'tasks.json'),configPath=join(root,'config.json');
    await mkdir(notes);await writeFile(join(notes,'Cobalt.md'),'# Cobalt\n\nThe prototype uses glass lenses. Next review: compare the two samples.');
    await writeFile(calendar,['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:review','DTSTART;TZID=Europe/Berlin:20261024T100000','DTEND;TZID=Europe/Berlin:20261024T110000','SUMMARY:Cobalt review','ATTENDEE;CN=Alex:mailto:alex@example.test','END:VEVENT','END:VCALENDAR'].join('\r\n'));
    await writeFile(contacts,['BEGIN:VCARD','VERSION:3.0','UID:alex','FN:Alex Example','EMAIL:alex@example.test','TEL:+442079460958','END:VCARD'].join('\r\n'));
    await writeFile(tasks,JSON.stringify({version:1,tasks:[{id:'lens',title:'Compare Cobalt samples',project:{id:'cobalt-native',name:'Optics'},due:'2026-10-25'}]}));
    const c=configSchema.parse({timeZone:'Asia/Tokyo',maintenanceEnabled:true,libraryRoot:join(root,'cache'),enabledSources:['agenda','people','notes','todo'],sources:{
      agenda:{adapter:'ical',paths:[calendar]},people:{adapter:'vcard',paths:[contacts]},notes:{adapter:'markdown',root:notes},todo:{adapter:'tasks',connector:{type:'json',paths:[tasks]}},
    },contextEntities:{
      alex:{kind:'person',label:'Alex Example',identifiers:[{kind:'email',value:'alex@example.test'}],queries:[{source:'people',query:'alex@example.test'}]},
      cobalt:{kind:'project',label:'Cobalt telescope',people:['alex'],identifiers:[{kind:'project-id',source:'todo',value:'cobalt-native'}],queries:[{source:'notes',query:'Cobalt'},{source:'todo',query:'',task:{status:'open',projectId:'cobalt-native'}}]},
    }});
    expect((await syncSources(c,'todo')).ok).toBe(true);await writeFile(configPath,JSON.stringify(c));
    const originalBytes=await Promise.all([calendar,contacts,tasks,join(notes,'Cobalt.md')].map(p=>readFile(p)));
    client=new Client({name:'portable-context-fixture',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dir,'../src/mcp.ts')],env:{...process.env as Record<string,string>,SOURCE_SEARCH_CONFIG_FILE:configPath},stderr:'pipe'}));
    expect((await client.listTools()).tools.map(t=>t.name)).toContain('build_context');
    const call=async(name:string,args:Record<string,unknown>)=>{
      const response=await client!.callTool({name,arguments:args});expect(response.isError).not.toBe(true);return JSON.parse((response.content as any[])[0].text);
    };
    expect((await call('list_context_entities',{kind:'project'})).entities[0].id).toBe('cobalt');
    const meeting=(await call('search_sources',{queries:[{source:'agenda',query:'Cobalt',from:'2026-10-24T00:00:00Z',to:'2026-10-25T00:00:00Z'}]})).results[0].items[0];
    const prepared=await call('build_context',{mode:'meeting-prep',meeting:meeting.ref,entity:'cobalt',sources:c.enabledSources});
    expect(prepared.evidence).toHaveLength(4);expect(prepared.coverage.planComplete).toBe(true);
    expect(prepared.evidence.find((e:any)=>e.type==='calendar-event').occurredAt).toBe('2026-10-24T08:00:00Z');
    expect(prepared.evidence.find((e:any)=>e.type==='calendar-event').links[0].entity).toBe('alex');
    expect(prepared.evidence.find((e:any)=>e.type==='task').links[0].entity).toBe('cobalt');
    expect(prepared.evidence.find((e:any)=>e.type==='task').task.dueDate).toBe('2026-10-25');
    expect(prepared.searches.find((s:any)=>s.query.source==='todo').coverage.kind).toBe('synchronized-snapshot');
    for(const e of prepared.evidence)expect((await call('read_record',e.read)).record.ref).toEqual(e.ref);
    const input={mode:'project-resume',entity:'cobalt',sources:['notes','todo','people']};
    const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),'context',JSON.stringify(input)],{env:{...process.env,SOURCE_SEARCH_CONFIG_FILE:configPath},stdout:'pipe',stderr:'pipe'});
    const output=JSON.parse(await new Response(child.stdout).text());expect(await child.exited).toBe(0);expect(output.data.evidence).toHaveLength(3);
    expect(output.data.evidence.map((e:any)=>e.ref)).toEqual((await call('build_context',input)).evidence.map((e:any)=>e.ref));
    const runtime=createRuntime(c),saved=prepared.evidence.find((e:any)=>e.ref.source==='notes').ref;
    c.contextEntities.cobalt!.records=[saved];await writeFile(join(notes,'Cobalt.md'),'# Cobalt\n\nThe new prototype uses mirrors.');
    expect((await runtime.build_context(input)).gaps.some(g=>g.code==='STALE_RECORD')).toBe(true);
    const edited=await readFile(join(notes,'Cobalt.md'));
    await runtime.build_context(input);expect(await readFile(join(notes,'Cobalt.md'))).toEqual(edited);
    expect(await Promise.all([calendar,contacts,tasks].map(p=>readFile(p)))).toEqual(originalBytes.slice(0,3));
    delete c.contextEntities.cobalt;await writeFile(configPath,JSON.stringify(c));
    expect((await call('list_context_entities',{kind:'project'})).entities).toEqual([]);
  }finally{await client?.close();await rm(root,{recursive:true,force:true});}
},30000);
