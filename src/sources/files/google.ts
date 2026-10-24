import {z} from 'zod';
import type {HttpRead} from '../../platform/http';
import {checked,pages} from '../sync/paging';
import {fail} from '../../domain/identity';
import {fileInventory,type RemoteFile,type FileBackend,type FileSelection} from './model';
const fields='id,name,mimeType,parents,trashed,modifiedTime,version,webViewLink,description,size';
const schema=z.object({id:z.string(),name:z.string(),mimeType:z.string(),parents:z.array(z.string()).optional(),trashed:z.boolean().optional(),modifiedTime:z.string(),version:z.string(),webViewLink:z.string().optional(),description:z.string().optional(),size:z.string().optional()});
const query=(v:Record<string,string>)=>new URLSearchParams(v).toString();
function file(value:unknown):RemoteFile{const v=checked(schema,value);if(v.trashed)fail('RECORD_NOT_FOUND','Google Drive file is trashed');return {id:v.id,name:v.name,mime:v.mimeType,parents:v.parents||[],folder:v.mimeType==='application/vnd.google-apps.folder',url:v.webViewLink||'https://drive.google.com/open?id='+encodeURIComponent(v.id),modifiedAt:v.modifiedTime,revision:v.version,description:v.description,size:v.size===undefined?undefined:Number(v.size)};}
export function googleFiles(selection:FileSelection,http:HttpRead,text:(path:string)=>Promise<string>):FileBackend{
  const backend:FileBackend={name:'google-drive',async get(id){const result=file(await http('/files/'+encodeURIComponent(id)+'?'+query({fields,supportsAllDrives:'true'})));if(id!=='root'&&result.id!==id)fail('INVALID_PROVIDER_RESPONSE','Google returned a different file');return result;},async children(id){
    const base='/files?'+query({q:"'"+id.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"' in parents and trashed = false",fields:'nextPageToken,incompleteSearch,files('+fields+')',pageSize:'1000',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
    return (await pages(base,async path=>{const p=checked(z.object({files:z.array(z.unknown()),incompleteSearch:z.boolean().optional(),nextPageToken:z.string().optional()}),await http(path));if(p.incompleteSearch)fail('INCOMPLETE_SOURCE','Google Drive returned an incomplete folder inventory');return {items:p.files.map(file),next:p.nextPageToken?base+'&pageToken='+encodeURIComponent(p.nextPageToken):undefined};})).items;
  },async scan(previous){
    const checkpoint=z.object({token:z.string(),reconciledAt:z.string()}).safeParse(previous?.checkpoint);let token=checkpoint.success?checkpoint.data.token:undefined,refresh=!previous||!checkpoint.success||Date.now()-Date.parse(checkpoint.data.reconciledAt)>86400000;
    if(token){try{const known=new Set(previous!.files.map(v=>v.id));const changes=await pages(token,async pageToken=>{const p=checked(z.object({changes:z.array(z.object({fileId:z.string().optional(),removed:z.boolean().optional(),file:z.object({id:z.string(),parents:z.array(z.string()).optional(),mimeType:z.string().optional()}).optional()})),nextPageToken:z.string().optional(),newStartPageToken:z.string().optional()}),await http('/changes?'+query({pageToken,fields:'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,parents,mimeType))',pageSize:'1000',supportsAllDrives:'true',includeItemsFromAllDrives:'true',includeRemoved:'true'})));return {items:p.changes,next:p.nextPageToken,checkpoint:p.newStartPageToken};});
      if(!changes.checkpoint)fail('INCOMPLETE_SOURCE','Google Drive omitted its change checkpoint');token=changes.checkpoint;
      refresh||=changes.items.some(v=>known.has(v.fileId||v.file?.id||'')||v.file?.mimeType==='application/vnd.google-apps.folder'||v.file?.parents?.some(id=>known.has(id)))||false;
    }catch(e){if((e as any).code!=='SYNC_STATE_EXPIRED')throw e;token=undefined;refresh=true;}}
    if(!token)token=checked(z.object({startPageToken:z.string()}),await http('/changes/startPageToken?supportsAllDrives=true')).startPageToken;
    const files=refresh?await fileInventory(selection,backend):previous!.files;
    return {files,checkpoint:{token,reconciledAt:refresh?new Date().toISOString():checkpoint.success?checkpoint.data.reconciledAt:new Date().toISOString()},strategy:refresh?'change-feed-and-selected-folder-inventory':'change-feed'};
  },async text(v){return text('/files/'+encodeURIComponent(v.id)+(v.mime==='application/vnd.google-apps.document'?'/export?mimeType=text%2Fplain':'?alt=media&supportsAllDrives=true'));}};
  return backend;
}
