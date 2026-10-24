import {test,expect} from 'bun:test';
import {googleFiles} from '../src/sources/files/google';
import {microsoftFiles,downloadText} from '../src/sources/files/microsoft';
import {fileProvider} from '../src/sources/files/model';
import {configSchema} from '../src/platform/config';
import {sourceAuthorization} from '../src/platform/source-auth';

const selection={roots:['folder'],excludeNames:['Books','Ebooks'],content:'text' as const,maxTextBytes:8192};
const googleFile=(id:string,name:string,mimeType='text/plain',parents=['folder'])=>({id,name,mimeType,parents,modifiedTime:'2026-10-24T12:00:00Z',version:'1',size:'100'});
test('Google Drive checks changes, reuses unchanged text, prunes moves/deletions and never downloads excluded books',async()=>{
  let phase=0,downloads=0,scans=0;
  const folder=googleFile('folder','Research','application/vnd.google-apps.folder',[]),notes=googleFile('notes','Observations.txt'),book=googleFile('book','Physics.epub','application/epub+zip'),books=googleFile('books','Books','application/vnd.google-apps.folder');
  const backend=googleFiles(selection,async path=>{
    if(path.startsWith('/changes/startPageToken'))return {startPageToken:'one'};
    if(path.startsWith('/changes?'))return {changes:phase===2?[{fileId:'notes',removed:true}]:phase===1?[{fileId:'unrelated',file:{id:'unrelated',parents:['outside']}}]:[],newStartPageToken:'next'};
    if(path.startsWith('/files/folder?'))return folder;
    if(path.startsWith('/files/notes?'))return phase===2?{...notes,parents:['outside']}:notes;
    if(path.startsWith('/files/outside?'))return googleFile('outside','Other','application/vnd.google-apps.folder',[]);
    if(path.startsWith('/files?')){scans++;return {files:phase===2?[]:[notes,book,books]};}
    throw Error('Unexpected fixture request '+path);
  },async()=>{downloads++;return 'Invented spectral analysis';});
  const provider=fileProvider('drive',selection,backend),first=await provider.sync();expect(first.records.map(r=>r.title)).toEqual(['Research','Observations.txt']);expect(downloads).toBe(1);
  phase=1;const unchanged=await provider.sync(first.checkpoint);expect(unchanged.records.map(r=>r.ref)).toEqual(first.records.map(r=>r.ref));expect(scans).toBe(1);expect(downloads).toBe(1);
  phase=2;const removed=await provider.sync(unchanged.checkpoint);expect(removed.records).toHaveLength(1);await expect(provider.read('notes')).rejects.toMatchObject({code:'RECORD_NOT_FOUND'});
});
test('Drive metadata mode requests no contents and incomplete inventories cannot replace a snapshot',async()=>{
  const s={...selection,content:'metadata' as const};let contents=0;
  const backend=googleFiles(s,async path=>path.startsWith('/changes/start')?{startPageToken:'one'}:path.startsWith('/files/folder?')?googleFile('folder','Research','application/vnd.google-apps.folder',[]):{files:[],incompleteSearch:true},async()=>{contents++;return '';});
  await expect(fileProvider('drive',s,backend).sync()).rejects.toMatchObject({code:'INCOMPLETE_SOURCE'});expect(contents).toBe(0);
  const c=configSchema.parse({sources:{drive:{adapter:'files',roots:['folder'],connector:{type:'google',account:'invented',token:{env:'GOOGLE_TOKEN'}}}}});
  expect(c.enabledSources).toEqual([]);expect(sourceAuthorization(c,'drive').scopes).toEqual(['https://www.googleapis.com/auth/drive.metadata.readonly']);
});
test('OneDrive observes folder moves, follows empty delta pages, and never persists temporary download URLs',async()=>{
  let phase=0,downloads=0;
  const folder={id:'folder',name:'Research',folder:{},lastModifiedDateTime:'2026-10-24T12:00:00Z',eTag:'one',webUrl:'https://onedrive.example.test/folder'};
  const note={id:'note',name:'Observations.txt',file:{mimeType:'text/plain'},parentReference:{id:'folder'},lastModifiedDateTime:'2026-10-24T12:00:00Z',eTag:'one',webUrl:'https://onedrive.example.test/note',size:10};
  const backend=microsoftFiles(selection,undefined,async path=>{
    if(path.includes('/root/delta'))return path.includes('skip=next')?{value:phase?[{id:'note',deleted:{}}]:[],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=next'}:path.includes('token=latest')?{value:[],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=first'}:{value:[],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/drive/root/delta?skip=next'};
    if(path.includes('/folder/children'))return {value:phase?[]:[note]};
    if(path.includes('/folder?'))return folder;
    if(path.includes('@microsoft.graph.downloadUrl'))return {id:'note','@microsoft.graph.downloadUrl':'https://download.example.test/temporary-secret'};
    return note;
  },async(url)=>{expect(url).toContain('temporary-secret');downloads++;return 'Invented spectrum';});
  const p=fileProvider('onedrive',selection,backend),first=await p.sync();expect(first.records).toHaveLength(2);expect(downloads).toBe(1);expect(JSON.stringify(first)).not.toContain('temporary-secret');
  phase=1;expect((await p.sync(first.checkpoint)).records).toHaveLength(1);
  expect(await downloadText('https://download.example.test/file',100,async(_url,init)=>{expect(init.headers).toBeUndefined();expect(init.redirect).toBe('error');return new Response('Invented text');})).toBe('Invented text');
});
