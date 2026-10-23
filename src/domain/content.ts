import { matchesQuery, words, wordPattern } from "./query";
import { fail, hash } from "./identity";
import { type RecordData, type Query, type TextSection, type SectionKind, type MatchInfo } from "./contracts";

export function contentSections(record: RecordData): TextSection[] {
  if(record.sections)return record.sections;
  const body=record.body, sections:TextSection[]=[], markers:{start:number;kind:SectionKind}[]=[{start:0,kind:"primary"}];
  if(body.startsWith("---")){const front=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(body);if(front){markers[0]!.kind="metadata";markers.push({start:front[0].length,kind:"primary"});}}
  const transcripts=record.type.includes("transcript") || !record.adapter && ["voice-journals","call-notes","calls"].includes(record.ref.source);
  if(transcripts)for(const m of body.matchAll(/^(?:#{1,3}\s+)?(Source Metadata|Muesli Generated Notes|Original transcript|Transcript|Reviewed Transcript|Clean Transcript|Generated meeting notes|Manual notes|Review Notes|Meeting Summary|Key Discussion Points|Action Items|Decisions)(?:[^\S\r\n]*\r?\n|[^\S\r\n]*$)/gim)){
    const label=m[1]!.toLowerCase();
    markers.push({start:m.index,kind:label==="source metadata"?"metadata":label.startsWith("review notes")?"review":label==="manual notes"?"manual":/transcript/.test(label)?"primary":"generated"});
  }
  if(record.type === "email")for(const m of body.matchAll(/^(?:>.*|On [^\n]+wrote:|[-_]{3,}\s*(?:Original Message|Forwarded message)[^\n]*)/gm))markers.push({start:m.index,kind:"quoted"});
  // Only explicit signature/footer boundaries are classified; source wording stays intact.
  if(record.type === "email")for(const m of body.matchAll(/^(?:--[ \t]\r?$|(?:www\.[\w.-]+[ \t]*\|[ \t]*)?(?:Unsubscribe|Manage (?:your )?(?:email )?preferences|Community:)[ \t]*(?:https?:\/\/|<https?:\/\/)[^\r\n]*)/gm))markers.push({start:m.index,kind:"metadata"});
  const appended=body.indexOf("\n\nOriginal export record\n");if(appended>=0)markers.push({start:appended,kind:"metadata"});
  markers.sort((a,b)=>a.start-b.start);
  for(let i=0;i<markers.length;i++){const m=markers[i]!,end=markers[i+1]?.start ?? body.length;if(end>m.start)sections.push({kind:m.kind,start:m.start,end});}
  return sections;
}
export function findRecordMatch(record: RecordData,q:Pick<Query,"query"|"match"|"sections">):MatchInfo|undefined {
  if(!q.query.trim())return !q.sections || contentSections(record).some(s=>q.sections!.includes(s.kind) && record.body.slice(s.start,s.end).trim()) ? {field:"browse"} : undefined;
  const sections=contentSections(record).filter(s=>q.sections ? q.sections.includes(s.kind) : s.kind!=="metadata");
  const priority:SectionKind[]=["primary","manual","quoted","generated","review","metadata"];
  for(const kind of priority)for(const s of sections.filter(s=>s.kind===kind)){
    const text=record.body.slice(s.start,s.end);
    if(matchesQuery(text,q)){
      const term=words(q.query)[0];
      const word=q.match === "phrase" ? new RegExp(q.query.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"iu").exec(text) : term ? [...text.matchAll(wordPattern)].find(m=>m[0].normalize("NFKC").toLocaleLowerCase().startsWith(term)) : undefined;
      const first=word?.index ?? -1;
      // Normalization can change string length; a location is offered only for an exact original-text term.
      const start=s.start+Math.max(0,first);
      return {field:"body",section:s.kind,...(first>=0 ? {start,end:start+(word?.[0].length || 0)} : {}),explanation:`Matched ${s.kind} text`};
    }
  }
  if(!q.sections && matchesQuery(record.title,q))return {field:"title",explanation:record.body ? "Matched the title/name" : "Matched the title/name; no readable message text"};
  if(matchesQuery((q.sections ? "" : record.title+"\n")+sections.map(s=>record.body.slice(s.start,s.end)).join("\n"),q))return {field:"body",explanation:"Terms occur across multiple fields/sections; no single matching passage"};
  return undefined;
}
export function recordSearchText(record:RecordData){return contentSections(record).filter(s=>s.kind!=="metadata").map(s=>record.body.slice(s.start,s.end)).join("\n");}
export function focusToken(record:RecordData,match:MatchInfo) {
  return Buffer.from(JSON.stringify([1,hash(record.ref.source+":"+record.ref.id+":"+(record.ref.version || "")+":"+record.body),match.start,match.end])).toString("base64url");
}
export function focusedOffset(record:RecordData,token:string) {
  try {
    const [version,key,start,end]=JSON.parse(Buffer.from(token,"base64url").toString());
    if(version!==1 || key!==hash(record.ref.source+":"+record.ref.id+":"+(record.ref.version || "")+":"+record.body) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<start || end>record.body.length)throw Error();
    return Math.max(0,start-1000);
  } catch {return fail("STALE_FOCUS","Focus does not match this original; search again for its current passage");}
}
