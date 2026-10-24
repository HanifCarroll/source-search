import {extname,join} from 'node:path';
import {writeFile,rename,rm} from 'node:fs/promises';
import {loadConfig,requireMaintenance,requireSource,sourceScope,type Config} from '../platform/config';
import {connector,readMail} from '../sources/mail/index';
import {assertVersion,fail,hash} from '../domain/identity';
import {privateDirectory} from '../platform/storage';
const supported=new Set(['.txt','.html','.htm','.rtf','.doc','.docx','.pdf','.odt','.csv','.tsv','.srt','.vtt','.png','.jpg','.jpeg','.tif','.tiff','.webp','.gif','.mp3','.m4a','.wav','.aac','.flac','.ogg','.opus','.mp4','.mov','.mkv','.webm']);
export async function downloadAttachments(c:Config,input:{source:string;id:string;version?:string;scope:string}) {
 requireMaintenance(c);requireSource(c,'documents');requireSource(c,input.source);
 if(input.scope!==sourceScope(c,input.source))fail('STALE_RECORD','Cached attachment belongs to a different account configuration');
 const backend=connector(c,input.source);if(!backend)fail('UNSUPPORTED_PROVIDER','No native attachment connector is configured');
 const current=await readMail(input.source,input.id,undefined,c);assertVersion({source:input.source,id:input.id,version:input.version},current.ref.version!);
 const folder=join(c.libraryRoot,'attachments',input.source+'-'+(input.id.length>180?hash(input.id):input.id));await privateDirectory(folder);
 const files=await backend.attachments(input.id);if(files.length>100)fail('OUTPUT_LIMIT','Message has too many attachments');
 const entries=[];let total=0;
 for(const item of files){
  const extension=extname(item.filename).toLowerCase();if(!supported.has(extension))continue;
  const bytes=await backend.download(input.id,item.id,25*1024*1024);total+=bytes.length;if(total>250*1024*1024)fail('OUTPUT_LIMIT','Message attachments exceed download budget');
  const path=join(folder,hash(item.id+'\0'+item.filename)+extension),temporary=path+'.'+crypto.randomUUID()+'.tmp';
  try{await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
  entries.push({path,name:item.filename});
 }
 return {entries};
}
if(import.meta.main){process.umask(0o077);const input=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify(await downloadAttachments(await loadConfig(),input)));}
