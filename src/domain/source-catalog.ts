export type Tracking = 'snapshot'|'mail'|'markdown'|'native'|'browser'|'pim'|'archive'|'vault'|'agent-history'|null;
export type SourceDefinition = {
  category:string;
  family:'connected'|'tasks'|'mail'|'markdown'|'native'|'browser'|'pim'|'archive'|'vault'|'agent-history'|'library';
  tracking:Tracking;
  projected:boolean;
  context:'none'|'neighbors'|'inline';
  filters:readonly string[];
  sort:readonly ('newest'|'oldest'|'relevance'|'due')[];
  ranked?:boolean;
  trimItems?:boolean;
};
const dates=['from','to'] as const;
const ordered=['newest','oldest'] as const;
const ranked=[...ordered,'relevance'] as const;
const definition=(value:Partial<SourceDefinition>&Pick<SourceDefinition,'category'|'family'|'tracking'>):SourceDefinition=>({
  projected:false,context:'none',filters:[...dates,'sections'],sort:ordered,trimItems:true,...value,
});
const connected=(category:string,filters:readonly string[]=[...dates,'types','conversation','sections'],sort:SourceDefinition['sort']=ranked)=>
  definition({category,family:'connected',tracking:'snapshot',projected:true,filters,sort});
const mail=(sort:SourceDefinition['sort']=ordered,trimItems=true)=>definition({
  category:'mail',family:'mail',tracking:'mail',projected:true,context:'neighbors',sort,trimItems,
  filters:[...dates,'folders','excludeSpamTrash'],
});
const archive=(category:string,context:SourceDefinition['context']='none',extra:string[]=[])=>definition({
  category,family:'archive',tracking:'archive',projected:true,context,sort:ranked,
  filters:[...dates,'types',...(context==='neighbors'?['conversation']:[]),'sections',...extra],
});
const browser=(category:string,sort:SourceDefinition['sort']=ordered)=>definition({category,family:'browser',tracking:'browser',sort});
const chromeHistory=browser('browser-history'),chromeBookmarks=browser('browser-bookmarks',ranked),chromeDownloads=browser('browser-downloads');

// Capabilities describe adapters; configured source IDs name instances. Runtime
// readers and maintenance factories consume this data without importing each other.
export const sourceDefinitions = {
  calendars:connected('calendars'),
  'address-books':connected('contacts',['types','sections'],['relevance']),
  notes:connected('notes'),files:connected('files'),issues:connected('issues'),chat:connected('chat'),
  repositories:connected('repositories',['types','sections'],['relevance']),
  tasks:definition({category:'tasks',family:'tasks',tracking:'snapshot',projected:true,filters:[...dates,'types','sections','task'],sort:[...ranked,'due']}),
  gmail:mail(['newest'],false),fastmail:mail(),jmap:mail(),imap:mail(),
  markdown:definition({category:'notes',family:'markdown',tracking:'markdown',sort:ranked}),
  muesli:definition({category:'muesli',family:'native',tracking:'native',projected:true}),
  whatsapp:definition({category:'whatsapp',family:'native',tracking:'native',projected:true,context:'neighbors',filters:[...dates,'conversation','sections']}),
  messages:definition({category:'messages',family:'native',tracking:'native',projected:true,context:'neighbors',filters:[...dates,'conversation','sections']}),
  'things-archive':{...archive('tasks'),filters:[...dates,'types','sections','task'],sort:[...ranked,'due']},
  'chatgpt-archive':archive('chatgpt-archive','neighbors',['roles','contentTypes','selectedBranch']),
  'takeout-archive':archive('takeout-archive','none',['excludeSpamTrash']),
  'linkedin-archive':archive('linkedin-archive','neighbors'),
  'twitter-archive':archive('twitter-archive','neighbors'),
  calendar:definition({category:'calendars',family:'pim',tracking:'pim',sort:ranked}),
  contacts:definition({category:'contacts',family:'pim',tracking:'pim',filters:['sections'],sort:['relevance']}),
  ical:definition({category:'calendars',family:'pim',tracking:'pim',sort:ranked}),
  vcard:definition({category:'contacts',family:'pim',tracking:'pim',filters:['sections'],sort:['relevance']}),
  'chrome-history':chromeHistory,'chrome-bookmarks':chromeBookmarks,'chrome-downloads':chromeDownloads,
  'browser-history':chromeHistory,'browser-bookmarks':chromeBookmarks,'browser-downloads':chromeDownloads,
  'firefox-history':browser('browser-history'),'firefox-bookmarks':browser('browser-bookmarks',ranked),
  'safari-history':browser('browser-history'),'safari-bookmarks':browser('browser-bookmarks',['relevance']),
  'agent-history':definition({category:'agent-history',family:'agent-history',tracking:'agent-history',context:'inline',ranked:true,trimItems:false,filters:[...dates,'mode'],sort:['relevance']}),
  vault:definition({category:'notes',family:'vault',tracking:'vault',ranked:true,filters:['mode'],sort:['relevance']}),
  library:definition({category:'library',family:'library',tracking:null,ranked:true,filters:['mode'],sort:['relevance']}),
  documents:definition({category:'documents',family:'library',tracking:null,projected:true,ranked:true,filters:['mode'],sort:['relevance']}),
} satisfies Record<string,SourceDefinition>;
export type AdapterKind = keyof typeof sourceDefinitions;
export const adapterKinds=Object.keys(sourceDefinitions) as [AdapterKind,...AdapterKind[]];
export const connectedKinds=adapterKinds.filter(kind=>sourceDefinitions[kind].family==='connected');
export type SourceCatalog = {sources?:Record<string,{adapter:AdapterKind}>};

// Compatibility for saved references and configurations from before instances.
const legacy:Record<string,AdapterKind> = {'mail-personal':'gmail','mail-consulting':'gmail','mail-fastmail':'fastmail',journals:'markdown','voice-journals':'markdown','call-notes':'markdown',calls:'muesli'};
export function sourceKind(source:string,catalog:SourceCatalog={}):string {
  const adapter=catalog.sources?.[source]?.adapter || legacy[source] || source;
  return adapter.startsWith('browser-') ? adapter.replace('browser-','chrome-') : adapter;
}
export function sourceDefinition(source:string,catalog:SourceCatalog={}):SourceDefinition|undefined {
  return sourceDefinitions[sourceKind(source,catalog) as AdapterKind];
}
export function sourceCategory(source:string,catalog:SourceCatalog={}) {
  return sourceDefinition(source,catalog)?.category || sourceKind(source,catalog);
}
export function isMail(source:string,catalog:SourceCatalog={}) {return sourceDefinition(source,catalog)?.family==='mail';}
export const groupIds=['all-mail','all-journals','all-notes','historical-exports','all-tasks','all-browser-history','all-bookmarks','all-calendars','all-contacts','all-files','all-issues','all-chats','all-repositories'] as const;
