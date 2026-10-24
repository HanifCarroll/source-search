import type {Query} from '../../domain/contracts';
export type Folder={id:string;name:string;role:string|null};
// This normalized shape also preserves existing mailbridge record versions.
export type MailSummary={message_id:string;thread_id?:string|null;subject?:string|null;from?:string|null;to:string[];cc?:string[];date?:string|null;snippet?:string|null;folders:Folder[];messageId?:string};
export type MailDetail={summary:MailSummary;body_text?:string|null;body_html?:string|null;attachments:{filename:string;mime_type?:string|null}[];warnings?:string[]};
export type MailContinuation={position:number;state:string;scope?:string};
export type MailResults={messages:MailSummary[];position:number;queryState:string;total:number;warnings:string[]};
export type MailThread={messages:MailDetail[];warnings:string[]};
export type MailAttachment={id:string;filename:string;mime_type:string;size:number};
// Checkpoints are local to an account/scope. A full inventory may prune only
// when its final page succeeds; deltas name removals explicitly.
export type MailSyncPage={checkpoint:unknown;messages:MailDetail[];removed:string[];inventory?:string[];hasMore:boolean;strategy:string};
export interface MailConnector {
  sync(checkpoint?:unknown):Promise<MailSyncPage>;
  status():Promise<{folders:Folder[];warnings:string[]}>;
  search(q:Query,page?:MailContinuation):Promise<MailResults>;
  read(id:string):Promise<MailDetail>;
  thread(id:string,selectedId:string):Promise<MailThread>;
  attachments(id:string):Promise<MailAttachment[]>;
  download(id:string,attachment:string,maxBytes:number):Promise<Uint8Array>;
}
