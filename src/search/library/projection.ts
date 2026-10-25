import {hash} from '../../domain/identity';
import {contentSections} from '../../domain/content';
import type {RecordData,Ref} from '../../domain/contracts';

export const searchProjectionVersion=1;
export type SearchSpan={start:number;end:number;canonicalStart:number};
export type Chunk={id:string;source:string;title:string;body:string;hash:string;refs:Ref[];guard:unknown;searchText:string;searchHash:string;searchSpans:SearchSpan[]};
type Piece={text:string;searchable:boolean};
const text=(value:string):Piece=>({text:value,searchable:true});
const provenance=(value:string):Piece=>({text:value,searchable:false});

// Build both representations from the same pieces. Never strip patterns out of
// user prose: a record may legitimately contain an "Original:" or warning line.
function project(pieces:Piece[]){
  let body='',searchText='';const searchSpans:SearchSpan[]=[];
  for(const piece of pieces){
    if(piece.searchable && piece.text.length){
      searchSpans.push({start:searchText.length,end:searchText.length+piece.text.length,canonicalStart:body.length});
      searchText+=piece.text;
    }
    body+=piece.text;
  }
  return {body,hash:hash(body),searchText,searchHash:hash(searchText),searchSpans};
}

export function makeChunks(source:string,records:RecordData[],guard:unknown):Chunk[]{
  const groups=new Map<string,RecordData[]>();
  for(const record of records){
    if(!record.body.trim())continue;
    const adapter=record.adapter||source;
    const grouped=!!record.conversation && ['messages','whatsapp','chatgpt-archive','linkedin-archive'].includes(adapter);
    const key=grouped?record.conversation+':'+(record.occurredAt||'undated').slice(0,10):adapter==='linkedin-archive'&&!/post|article/.test(record.type)?record.type+':'+(record.occurredAt||'undated').slice(0,10):record.ref.id;
    const group=groups.get(key)||[];group.push(record);groups.set(key,group);
  }
  const chunks:Chunk[]=[];
  for(const [group,records] of groups){
    records.sort((a,b)=>(a.occurredAt||'').localeCompare(b.occurredAt||'')||a.ref.id.localeCompare(b.ref.id));
    let parts:Piece[][]=[],refs:Ref[]=[],size=0,ordinal=0;
    const title=records[0]!.title.slice(0,180);
    function flush(){
      if(!parts.length)return;
      const pieces=[text(`# ${title}\n\n`),provenance(`Derived search text. Source: ${source}. Read original references before citing.\n\n`),...parts.flatMap((part,i)=>i?[text('\n\n'),...part]:part)];
      chunks.push({id:hash(source+':'+group+':'+ordinal++),source,title,...project(pieces),refs,guard});
      parts=[];refs=[];size=0;
    }
    for(const record of records){
      // Preserve section provenance, roles and branches in both representations.
      const content=contentSections(record).filter(s=>s.kind!=='metadata').map(s=>`[${s.kind}]\n`+record.body.slice(s.start,s.end)).join('\n\n');
      const header=[text(`## ${record.title.slice(0,180)}\nAuthor: ${record.author||'unspecified'}\nDate: ${record.occurredAt||'unspecified'}\n`),provenance(`Original: ${JSON.stringify(record.ref)}\n`),text(record.metadata?.selectedBranch!==undefined?`Selected branch: ${record.metadata.selectedBranch}\n`:'')];
      for(let offset=0;offset<content.length;){
        let end=Math.min(content.length,offset+10000);
        if(end<content.length){const line=content.lastIndexOf('\n',end);if(line>offset+5000)end=line+1;}
        const part=[...header,text((offset?`Continuation at character ${offset}\n`:'')+content.slice(offset,end))];
        const length=part.reduce((n,p)=>n+p.text.length,0);
        // Grouping and canonical bytes intentionally preserve saved references.
        if(size+length>14000||refs.length>=20)flush();
        parts.push(part);if(!refs.some(ref=>ref.id===record.ref.id))refs.push(record.ref);
        size+=length;offset=end;
      }
    }
    flush();
  }
  return chunks;
}

export function canonicalPassage(spans:SearchSpan[],start:number,end:number){
  const first=spans.find(span=>span.end>start),last=spans.findLast(span=>span.start<end);
  if(!first||!last||end<=start)return;
  return {start:first.canonicalStart+Math.max(0,start-first.start),end:last.canonicalStart+Math.min(last.end,end)-last.start};
}
