import {z} from 'zod';
import {fail,now,versioned} from '../../domain/identity';
import {readableHtml} from '../../formats/html';
import type {SourceProvider} from '../sync/model';
import {checked} from '../sync/paging';

export const fileSchema=z.object({id:z.string().min(1),name:z.string(),mime:z.string(),parents:z.array(z.string()),folder:z.boolean(),url:z.string(),modifiedAt:z.string(),revision:z.string(),description:z.string().optional(),size:z.number().optional()});
export type RemoteFile=z.infer<typeof fileSchema>;
export type FileSelection={roots:string[];excludeNames:string[];content:'metadata'|'text';maxTextBytes:number};
export type Inventory={files:RemoteFile[];checkpoint:unknown;strategy:string};
export interface FileBackend{
  name:string;
  get(id:string):Promise<RemoteFile>;
  children(id:string):Promise<RemoteFile[]>;
  scan(previous?:Inventory):Promise<Inventory>;
  text(file:RemoteFile):Promise<string>;
}
const state=z.object({version:z.literal(1),inventory:z.object({files:z.array(fileSchema),checkpoint:z.unknown(),strategy:z.string()}),text:z.record(z.string(),z.object({revision:z.string(),body:z.string()}))});
export function excluded(file:RemoteFile,selection:FileSelection){return /\.(epub|mobi|azw3?|fb2|djvu)$/i.test(file.name)||selection.excludeNames.some(p=>new Bun.Glob(p.toLowerCase()).match(file.name.toLowerCase()));}
export function textual(file:RemoteFile){return file.mime.startsWith('text/')||['application/json','application/xml','application/javascript','application/x-yaml','application/vnd.google-apps.document'].includes(file.mime)||/\.(md|markdown|txt|csv|tsv|json|ya?ml|html?|xml)$/i.test(file.name);}
export async function fileInventory(selection:FileSelection,backend:Pick<FileBackend,'get'|'children'>){
  const files:RemoteFile[]=[],seen=new Set<string>(),queue=await Promise.all(selection.roots.map(id=>backend.get(id)));
  while(queue.length){const file=queue.shift()!;if(seen.has(file.id)||excluded(file,selection))continue;seen.add(file.id);files.push(file);if(files.length>100000)fail('SOURCE_LIMIT','Selected folders exceed 100,000 items');if(file.folder)queue.push(...await backend.children(file.id));}
  return files;
}
export async function selectedFile(id:string,selection:FileSelection,backend:Pick<FileBackend,'get'>){
  const file=await backend.get(id);if(excluded(file,selection))fail('RECORD_NOT_FOUND','File is excluded');
  const roots=new Set(await Promise.all(selection.roots.map(async id=>(await backend.get(id)).id))),queue=[file],seen=new Set<string>();
  while(queue.length){const item=queue.shift()!;if(seen.has(item.id)||excluded(item,selection))continue;seen.add(item.id);if(roots.has(item.id))return file;if(seen.size>1000)fail('SOURCE_LIMIT','File ancestry exceeds 1,000 folders');for(const parent of item.parents)queue.push(await backend.get(parent));}
  return fail('RECORD_NOT_FOUND','File is no longer inside the selected folders');
}
export function fileProvider(source:string,selection:FileSelection,backend:FileBackend):SourceProvider{
  function record(file:RemoteFile,text?:string){return versioned({adapter:'files',ref:{source,id:file.id},title:file.name,body:[file.name,file.description,`Type: ${file.mime}`,`Modified: ${file.modifiedAt}`,text].filter(Boolean).join('\n\n'),type:file.folder?'folder':'file',locator:file.url,occurredAt:file.modifiedAt,observedAt:now(),metadata:{provider:backend.name,mime:file.mime,content:text===undefined?'metadata':'text'}});}
  async function contents(file:RemoteFile){if(file.folder||selection.content!=='text'||!textual(file)||file.size!==undefined&&file.size>selection.maxTextBytes)return undefined;const body=await backend.text(file);if(Buffer.byteLength(body)>selection.maxTextBytes)fail('SOURCE_LIMIT','File text exceeds maxTextBytes');return file.mime==='text/html'||/\.html?$/i.test(file.name)?readableHtml(body):body;}
  return {async lists(){return (await backend.children('root')).map(v=>({id:v.id,name:v.name+(v.folder?'/':'')}));},async sync(previous){
    const parsed=state.safeParse(previous),old=parsed.success?parsed.data:undefined,inventory=await backend.scan(old?.inventory),text:Record<string,{revision:string;body:string}>={},records=[],warnings=[];let metadataOnly=0;
    for(const file of inventory.files){if(excluded(file,selection))continue;const cached=old?.text[file.id],body=selection.content==='text'&&cached?.revision===file.revision?cached.body:await contents(file);if(body!==undefined)text[file.id]={revision:file.revision,body};else if(selection.content==='text'&&!file.folder)metadataOnly++;records.push(record(file,body));}
    if(metadataOnly)warnings.push(`${metadataOnly} files have metadata only because their type or size is outside text extraction settings`);
    return {records,checkpoint:{version:1,inventory,text},strategy:inventory.strategy,coverage:'Selected folders and files; known ebook formats and excluded names omitted. '+(selection.content==='text'?'Text files and Google Docs include content; other formats retain metadata.':'Metadata only; file contents are not downloaded.'),warnings};
  },async read(id){const file=await selectedFile(id,selection,backend);return record(file,await contents(file));}};
}
