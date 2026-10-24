// Source IDs name configured instances; adapters describe their behavior.
export const adapterKinds = ['gmail','fastmail','jmap','imap','markdown','muesli','whatsapp','messages','things-archive','chatgpt-archive','takeout-archive','linkedin-archive','twitter-archive','calendar','contacts','ical','vcard','chrome-history','chrome-bookmarks','chrome-downloads','agent-history','vault','library','documents'] as const;
export type AdapterKind = typeof adapterKinds[number];
export type SourceCatalog = {sources?:Record<string,{adapter:AdapterKind}>};

// Compatibility for saved references and configurations from before instances.
// New configurations declare adapters explicitly and can use their own IDs.
const legacy:Record<string,AdapterKind> = {'mail-personal':'gmail','mail-consulting':'gmail','mail-fastmail':'fastmail',journals:'markdown','voice-journals':'markdown','call-notes':'markdown',calls:'muesli'};
export function sourceKind(source:string,catalog:SourceCatalog={}):string{return catalog.sources?.[source]?.adapter || legacy[source] || source;}
export function isMail(source:string,catalog:SourceCatalog={}){return ['gmail','fastmail','jmap','imap'].includes(sourceKind(source,catalog));}
export const groupIds=['all-mail','all-journals','all-notes','historical-exports'] as const;
