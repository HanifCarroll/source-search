export const connectedKinds=['calendars','address-books'] as const;
// Source IDs name configured instances; adapters describe their behavior.
export const adapterKinds = [...connectedKinds,'firefox-history','firefox-bookmarks','safari-history','safari-bookmarks','tasks','browser-history','browser-bookmarks','browser-downloads','gmail','fastmail','jmap','imap','markdown','muesli','whatsapp','messages','things-archive','chatgpt-archive','takeout-archive','linkedin-archive','twitter-archive','calendar','contacts','ical','vcard','chrome-history','chrome-bookmarks','chrome-downloads','agent-history','vault','library','documents'] as const;
export type AdapterKind = typeof adapterKinds[number];
export type SourceCatalog = {sources?:Record<string,{adapter:AdapterKind}>};

// Compatibility for saved references and configurations from before instances.
// New configurations declare adapters explicitly and can use their own IDs.
const legacy:Record<string,AdapterKind> = {'mail-personal':'gmail','mail-consulting':'gmail','mail-fastmail':'fastmail',journals:'markdown','voice-journals':'markdown','call-notes':'markdown',calls:'muesli'};
export function sourceKind(source:string,catalog:SourceCatalog={}):string{
 const adapter=catalog.sources?.[source]?.adapter || legacy[source] || source;
 // Browser instances describe Chromium-compatible data, including Edge/Brave.
 return adapter.startsWith('browser-')?adapter.replace('browser-','chrome-'):adapter;
}
export function sourceCategory(source:string,catalog:SourceCatalog={}){
 const kind=sourceKind(source,catalog);
 if(kind==='tasks'||kind==='things-archive')return 'tasks';
 if(['gmail','fastmail','jmap','imap'].includes(kind))return 'mail';
 if(['calendar','ical','calendars'].includes(kind))return 'calendars';
 if(['contacts','vcard','address-books'].includes(kind))return 'contacts';
 if(/^(firefox|safari)-/.test(kind))return 'browser-'+kind.split('-')[1];
 if(kind.startsWith('chrome-'))return kind.replace('chrome-','browser-');
 if(kind==='markdown'||kind==='vault')return 'notes';
 return kind;
}
export function isMail(source:string,catalog:SourceCatalog={}){return ['gmail','fastmail','jmap','imap'].includes(sourceKind(source,catalog));}
export const groupIds=['all-mail','all-journals','all-notes','historical-exports','all-tasks','all-browser-history','all-bookmarks','all-calendars','all-contacts'] as const;
