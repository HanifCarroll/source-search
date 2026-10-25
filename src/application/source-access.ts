import {connectedStatus,searchConnected,readConnected} from '../sources/connected';
import {browserStatus,searchBrowser,readBrowser} from '../sources/browser';
import {thingsRecords,searchThingsTasks} from '../sources/tasks/things';
import {taskStatus,searchTasks,readTask} from '../sources/tasks';
import {legacySource,type SourceAdapter as Adapter,type ReadResult} from './legacy-source';
import {filePimStatus,searchFilePim,readFilePim} from '../sources/local/pim-files';
import {sourceKind,isMail,connectedKinds} from '../domain/source-catalog';
import { searchMessages, readMessage, messagesStatus } from "../sources/messages/index";
import type { Query, Ref, RecordData, Page } from '../domain/contracts';
import { assertVersion, errorData, fail, hash } from '../domain/identity';
import { contextMode, usesLibrary } from '../domain/source-policy';
import { validateOptions } from '../domain/query';
import { requireSource, configuredSourceIds, mailAccount, markdownSettings, sourceConfig, sourceScope, type Config } from '../platform/config';
import { libraryStatus, searchLibrary, readLibrary, readDocument } from '../search/library/index';
import { qmdStatus, searchQmd, readQmd } from '../search/qmd/vault';
import { cassStatus, searchCass, readCass } from '../sources/agent-history/index';
import { isDailyJournal, journalPaths, searchJournals, journalRecord } from '../sources/local/journals';
import { databaseStatus, searchDatabase, readDatabase } from '../sources/local/databases';
import { notesStatus, searchNotes, readNote } from '../sources/local/notes';
import { pimStatus, searchPim, readPim } from '../sources/local/pim';
import { chromeStatus, searchChrome, readChrome } from '../sources/local/chrome';
import { searchMail, readMail, mailContext, mailStatus, run, type Run, type MailSource, type PreviewBudget } from '../sources/mail/index';
import { searchArchive, indexStatus } from '../sources/archives/index';
import { archiveSignature, checkExportSelection, readExport, exportPaths, exportProjectionVersion, chatGptContext, linkedInContext, twitterArchiveContext, type ArchiveSource } from '../sources/archives/originals';

type Source = Query['source'];
const recordOnly = (read: (ref: Ref, context: boolean) => Promise<RecordData>): Adapter['read'] =>
  async (ref, context) => ({record: await read(ref, context)});

// One registration binds status, native search and original reads for each source.
// This module owns routing and reference validation, never response formatting.
export function createSourceAccess(config: Config, execute: Run = run) {
  function mail(source: MailSource): Adapter {
    return {
      async status() {
        const result = await mailStatus(config,source) || await searchMail({source, query:sourceKind(source,config) === 'gmail' ? 'newer_than:1d' : '', limit:1}, execute, {remaining:0,records:new Map()}, config);
        const account = mailAccount(config,source)!;
        return {available:true, account:account.email, aliases:account.aliases,...('folders' in result?{folders:result.folders}:{}), querySyntax:sourceKind(source,config) === 'gmail' ? 'Gmail query syntax' : 'text terms or phrase', filters:['from','to','folders','excludeSpamTrash'], pagination:true, coverage:'Provider mailbox; full historical coverage has not been established', warnings:result.warnings};
      },
      search: (q, previews) => searchMail(q, execute, previews, config),
      async read(ref, context) {
        const record = await readMail(source, ref.id, execute, config);
        assertVersion(ref, record.ref.version!);
        if (!context) return {record};
        try { const neighbors = await mailContext(record, execute, config); return {record, context:neighbors.records, contextWarnings:neighbors.warnings}; }
        catch (e) { const error=errorData(e); return {record,contextWarnings:[`Thread context unavailable: ${error.code}: ${error.message}`]}; }
      },
    };
  }
  const archiveContext = {'chatgpt-archive':chatGptContext, 'linkedin-archive':linkedInContext, 'twitter-archive':twitterArchiveContext};
  function archive(source: ArchiveSource, settings:Config=config): Adapter {
    return {
      async status() {
        const selected=exportPaths(settings,source);
        if (!selected.length) return {available:false,error:{code:'SOURCE_NOT_CONFIGURED',message:'Fresh export not yet downloaded and selected'}};
        await checkExportSelection(settings,source);
        const state=await indexStatus(settings), index=state[source] ? JSON.parse(state[source]) : null;
        if (index) index.stale=(exportProjectionVersion(source)>1 && index.projectionVersion!==exportProjectionVersion(source)) || !!index.signature && index.signature!==await archiveSignature(settings,source);
        return {available:!!index,index,selectedExports:selected,coverage:'Selected original export snapshot; edits appear after explicit rebuild',filters:['from','to',...(source in archiveContext ? ['conversation'] : [])],querySyntax:'literal full-text terms, all must match',pagination:true};
      },
      search: q => searchArchive(settings,q),
      async read(ref, context) {
        const record=await readExport(settings,ref);
        const neighbors=archiveContext[source as keyof typeof archiveContext];
        if (!context || !neighbors) return {record};
        const result=await neighbors(settings,record);
        return {record,context:result.records,contextWarnings:result.warnings};
      },
    };
  }
  function database(source: string): Adapter {
    return {status:async()=>({available:true,...await databaseStatus(config,source),filters:['from','to',...(sourceKind(source,config)==='whatsapp'?['conversation']:[])],querySyntax:'literal words, all must match',pagination:true}), search:q=>searchDatabase(config,q), read:(ref,context)=>readDatabase(config,ref,context)};
  }
  function notes(source: string): Adapter {
    return {status:async()=>({available:true,...await notesStatus(config,source),filters:['from','to'],querySyntax:'literal words, all must match',pagination:true}),search:q=>searchNotes(config,q),read:recordOnly(ref=>readNote(config,ref))};
  }
  function pim(source: 'calendar' | 'contacts', settings:Config=config): Adapter {
    return {status:async()=>({available:true,...await pimStatus(settings,source),filters:source==='calendar'?['from and to required; bounded window continuation']:[],querySyntax:'literal words, all must match',pagination:true}),search:q=>searchPim(settings,q),read:recordOnly(ref=>readPim(settings,ref))};
  }
  function chrome(source: 'chrome-history' | 'chrome-bookmarks' | 'chrome-downloads', settings:Config=config): Adapter {
    return {status:async()=>({available:true,...await chromeStatus(settings,source),filters:['from','to'],querySyntax:'literal words, all must match',pagination:true}),search:q=>searchChrome(settings,q),read:recordOnly(ref=>readChrome(settings,ref))};
  }
  function canonical(kind:string, config:Config):Adapter|undefined {
    const readers:Record<string,Adapter>={
    'calendar':pim('calendar',config), 'contacts':pim('contacts',config),
    'chrome-history':chrome('chrome-history',config), 'chrome-bookmarks':chrome('chrome-bookmarks',config), 'chrome-downloads':chrome('chrome-downloads',config),
    'chatgpt-archive':archive('chatgpt-archive',config), 'takeout-archive':archive('takeout-archive',config),
    'linkedin-archive':archive('linkedin-archive',config), 'twitter-archive':archive('twitter-archive',config),
    messages: {
      status:async()=>({available:true,...await messagesStatus(config),filters:['from','to','conversation'],querySyntax:'literal words, all must match',coverage:'Local Mac store; bounded candidate scan with continuation'}),
      search:q=>searchMessages(config,q),
      async read(ref,context) {
        const result=await readMessage(config,ref,context);
        return {...result,contextWarnings:context && !result.record.conversation ? ['No unambiguous conversation was found; neighboring messages are unavailable.'] : []};
      },
    },
    'things-archive': {
      async status() {
        const originals=await thingsRecords(config);
        let index:unknown;
        try {const state=await indexStatus(config);index={...JSON.parse(state['things-archive']||'{}'),indexedAt:state.indexedAt,stale:state.generation!==originals.generation};}
        catch(e){index={available:false,error:errorData(e),action:'Run source-search rebuild'};}
        return {available:true,taskCount:originals.info.taskCount,dateRange:originals.info.createdDateRange,snapshotAt:originals.info.exportedAt,editedAt:originals.info.archiveEditedAt,index,filters:['from','to'],querySyntax:'literal full-text terms, all must match',coverage:'Edited historical archive; date filters use task creation time'};
      },
      search:q=>q.task||q.sort==='due'?searchThingsTasks(config,q):searchArchive(config,q),read:recordOnly(ref=>readExport(config,ref)),
    },
    vault:{status:async()=>({...await qmdStatus(config),pagination:true}),search:q=>searchQmd(config,q),read:recordOnly(ref=>readQmd(config,ref))},
    'agent-history':{status:async()=>({...await cassStatus(config),pagination:true}),search:q=>searchCass(config,q),read:recordOnly((ref,context)=>readCass(config,ref,context))},
    };
    return readers[kind];
  }
  const adapters:Record<Source,Adapter>={
    library:{status:()=>libraryStatus(config),search:q=>searchLibrary(config,q),read:recordOnly(ref=>readLibrary(config,ref,original=>read(original)))},
    documents:{
      async status(){const status=await libraryStatus(config),doc=status.sources?.find(s=>s.source==='documents');return {...doc,available:(doc?.embeddings?.indexedDocuments||0)>0,modelsPresent:status.modelsPresent};},
      search:q=>searchLibrary(config,q),
      read:recordOnly(async ref=>{const record=await readDocument(config,ref);if(record.metadata?.mailRef)await read(record.metadata.mailRef as Ref);return record;}),
    },
  };
  for(const id of configuredSourceIds(config)){
    const kind=sourceKind(id,config);
    if(isMail(id,config))adapters[id]=mail(id);
    else if(/^(firefox|safari)-/.test(kind))adapters[id]={status:()=>browserStatus(config,id),search:q=>searchBrowser(config,q),read:recordOnly(ref=>readBrowser(config,ref))};
    else if(connectedKinds.includes(kind as typeof connectedKinds[number]))adapters[id]={status:()=>connectedStatus(config,id),search:q=>searchConnected(config,q),read:recordOnly(ref=>readConnected(config,ref))};
    else if(kind==='tasks')adapters[id]={status:()=>taskStatus(config,id),search:q=>searchTasks(config,q),read:recordOnly(ref=>readTask(config,ref))};
    else if(kind==='markdown')adapters[id]=isDailyJournal(config,id)?{status:async()=>({available:true,dailyNotes:(await journalPaths(markdownSettings(config,id).root,markdownSettings(config,id).exclude)).paths.length,filters:['from','to'],coverage:'Daily Markdown journals'}),search:q=>searchJournals(config,q),read:recordOnly(ref=>journalRecord(config,ref))}:notes(id);
    else if(kind==='muesli' || kind==='whatsapp')adapters[id]=database(id);
    else if(kind==='ical'||kind==='vcard')adapters[id]={status:()=>filePimStatus(config,id),search:q=>searchFilePim(config,q),read:recordOnly(ref=>readFilePim(config,ref))};
    else if(!['library','documents'].includes(kind)) {
      const scoped=sourceConfig(config,id);
      const settings=config.sources[id] ? {...scoped,sources:{[kind]:config.sources[id]!},enabledSources:[kind]} : scoped;
      const adapter=canonical(kind,settings);
      if(adapter)adapters[id]=legacySource(id,kind,hash(id+sourceScope(config,id)),adapter);
    }
  }
  async function read(ref: Ref, options: {context?:boolean; continuation?:boolean} = {}): Promise<ReadResult> {
    requireSource(config,ref.source);
    if(!adapters[ref.source])fail('SOURCE_NOT_CONFIGURED','No adapter is configured for this source');
    const mode=contextMode(ref.source,config);
    // CASS neighbors form part of the record body, so continuation must retain
    // that same window. Separate neighboring records need fetching only once.
    const context=!!options.context && (mode==='inline' || !options.continuation);
    const result=await adapters[ref.source].read(ref,context);
    if(context && mode==='none')result.contextWarnings=[...(result.contextWarnings||[]),'This source does not support neighboring/thread context; the original record is returned.'];
    return result;
  }
  return {
    status: (source: Source) => {requireSource(config,source);if(!adapters[source])fail("SOURCE_NOT_CONFIGURED","No adapter is configured for this source");return adapters[source].status();},
    searchSession() {
      const previews:PreviewBudget={remaining:3,records:new Map()};
      return (q:Query) => {
        requireSource(config,q.source);if(!adapters[q.source])fail("SOURCE_NOT_CONFIGURED","No adapter is configured for this source");validateOptions(q,config);
        return usesLibrary(q,config) ? searchLibrary(config,q) : adapters[q.source].search(q,previews);
      };
    },
    read,
  };
}
