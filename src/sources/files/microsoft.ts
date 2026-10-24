import {z} from 'zod';
import {checked,collectionLink} from '../sync/paging';
import {graphPages,graphOrigin} from '../sync/graph';
import type {HttpRead} from '../../platform/http';
import {boundedBody} from '../../platform/http';
import {fail} from '../../domain/identity';
import {fileInventory,type RemoteFile,type FileBackend,type FileSelection} from './model';
const fields='id,name,file,folder,remoteItem,parentReference,lastModifiedDateTime,eTag,webUrl,description,size,deleted';
const raw=z.record(z.string(),z.any());
function file(value:unknown):RemoteFile{
  const v=checked(z.object({id:z.string(),name:z.string(),file:z.object({mimeType:z.string().optional()}).optional(),folder:raw.optional(),remoteItem:raw.optional(),parentReference:z.object({id:z.string().optional()}).optional(),lastModifiedDateTime:z.string(),eTag:z.string(),webUrl:z.string(),description:z.string().optional(),size:z.number().optional(),deleted:raw.optional()}),value);
  if(v.deleted)fail('RECORD_NOT_FOUND','OneDrive file was deleted');
  return {id:v.id,name:v.name,mime:v.remoteItem?'application/x-remote-shortcut':v.folder?'inode/directory':v.file?.mimeType||'application/octet-stream',parents:v.parentReference?.id?[v.parentReference.id]:[],folder:!!v.folder&&!v.remoteItem,url:v.webUrl,modifiedAt:v.lastModifiedDateTime,revision:v.eTag,description:v.description,size:v.size};
}
export async function downloadText(url:string,maxBytes:number,fetcher:(url:URL,init:RequestInit)=>Promise<Response>=fetch){
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)fail('INVALID_PROVIDER_RESPONSE','OneDrive returned an invalid download URL');
  let response:Response;try{response=await fetcher(u,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});}catch{return fail('PROVIDER_UNAVAILABLE','OneDrive download failed');}
  if(!response.ok)fail('PROVIDER_ERROR','OneDrive download returned HTTP '+response.status);
  return boundedBody(response,maxBytes);
}
export function microsoftFiles(selection:FileSelection,driveId:string|undefined,http:HttpRead,download:(url:string,maxBytes:number)=>Promise<string>=downloadText):FileBackend{
  const drive=driveId?'/drives/'+encodeURIComponent(driveId):'/me/drive',item=(id:string)=>drive+(id==='root'?'/root':'/items/'+encodeURIComponent(id)),delta=drive+'/root/delta';
  const backend:FileBackend={name:'onedrive',async get(id){const v=file(await http(item(id)+'?$select='+fields));if(id!=='root'&&v.id!==id)fail('INVALID_PROVIDER_RESPONSE','Microsoft returned a different file');return v;},async children(id){const path=item(id)+'/children';return (await graphPages(http,path,path+'?$select='+fields)).items.map(file);},async scan(previous){
    const parsed=z.object({token:z.string(),reconciledAt:z.string()}).safeParse(previous?.checkpoint);let token=parsed.success?parsed.data.token:undefined,refresh=!previous||!parsed.success||Date.now()-Date.parse(parsed.data.reconciledAt)>86400000;
    if(token){try{const changes=await graphPages(http,delta,collectionLink(graphOrigin+token,graphOrigin,delta),true),known=new Set(previous!.files.map(v=>v.id));token=changes.checkpoint;refresh||=changes.items.some(v=>known.has(v.id)||!!v.folder||known.has(v.parentReference?.id));}catch(e){if((e as any).code!=='SYNC_STATE_EXPIRED')throw e;token=undefined;refresh=true;}}
    if(!token)token=(await graphPages(http,delta,delta+'?token=latest',true)).checkpoint!;
    return {files:refresh?await fileInventory(selection,backend):previous!.files,checkpoint:{token,reconciledAt:refresh?new Date().toISOString():parsed.success?parsed.data.reconciledAt:new Date().toISOString()},strategy:refresh?'delta-and-selected-folder-inventory':'delta'};
  },async text(v){const result=checked(z.object({id:z.string(),'@microsoft.graph.downloadUrl':z.string()}),await http(item(v.id)+'?$select=id,@microsoft.graph.downloadUrl'));if(result.id!==v.id)fail('INVALID_PROVIDER_RESPONSE','Microsoft returned a different file download');return download(result['@microsoft.graph.downloadUrl'],selection.maxTextBytes);}};
  return backend;
}
