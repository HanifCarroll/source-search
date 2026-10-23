import { basename } from "node:path";
import { parseCsv, readableHtml, stripHtml } from "./vendor/takeout/parsers";
import { fail, hash, now, versioned, type RecordData, type TextSection } from "./shared";

const key = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const types: Record<string,string> = {
  messages:"linkedin-message", connections:"linkedin-connection", invitations:"linkedin-invitation",
  articles:"linkedin-article", shares:"linkedin-post", comments:"linkedin-comment", jobapplications:"linkedin-job-application"
};
// Search writing, conversations and career history; account, ad, inference and search-log data stay in the original ZIP.
const unsearchable = new Set(["adtargeting","adsclicked","lanadsengagement","inferencesaboutyou","inferredcredibilityscores","logins","securitychallenges","searchqueries","receiptsv2","registration","emailaddresses","phonenumbers","whatsappphonenumbers","privateidentityasset","verifications"]);
export function linkedInSearchableEntry(entry: string) {
  return !unsearchable.has(key(basename(entry).replace(/\.csv$/i, "").replace(/_\d+$/, "")));
}
export function linkedInType(entry: string) {
  if(/^Articles\/.*\.html$/i.test(entry))return "linkedin-article";
  const category = basename(entry).replace(/\.csv$/i, "").replace(/_\d+$/, "");
  return types[key(category)] || "linkedin-"+category.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}
export function linkedInFilterType(value:string,categories:{entry:string;recordType:string}[]) {
  const aliases:Record<string,string>={message:"linkedin-message",messages:"linkedin-message",post:"linkedin-post",posts:"linkedin-post",connection:"linkedin-connection",connections:"linkedin-connection",application:"linkedin-job-application",applications:"linkedin-job-application",articles:"linkedin-article",comments:"linkedin-comment",searchhistory:"linkedin-searchqueries"};
  return aliases[key(value)] || categories.find(c=>key(basename(c.entry).replace(/\.csv$/i,"").replace(/_\d+$/,""))===key(value))?.recordType || value;
}
function linkedInUrl(value?:string) {
  if(value)try {const url=new URL(value);if(!url.username && !url.password && !url.port && ["https:","http:"].includes(url.protocol) && (url.hostname==="linkedin.com" || url.hostname.endsWith(".linkedin.com"))){url.protocol="https:";return url.href;}}catch {}
}
function postText(value:string) {
  const lines=value.split(/\r?\n/);
  if(lines.length>2 && lines[0]!.endsWith('"') && lines.slice(1,-1).every(line=>line.startsWith('"') && line.endsWith('"')) && lines.at(-1)!.startsWith('"'))return [lines[0]!.slice(0,-1),...lines.slice(1).map(line=>line.slice(1,line.endsWith('"') ? -1 : undefined))].join("\n");
  return value;
}
function attachmentInfo(value?:string) {
  if(!value)return undefined;
  const assets=new Map<string,string>();
  for(const text of value.split(","))try {const path=new URL(text.trim()).pathname,id=/\/v2\/([^/]+)\//.exec(path)?.[1] || path;
    const kind=/messaging-document|messaging-uploadedDocument/.test(path) ? "document" : /transmuxed-video|videocover/.test(path) ? "video" : /messaging-image/.test(path) ? "image" : "file";assets.set(id,kind);
  }catch {assets.set(hash(text),"file");}
  return {count:assets.size,kinds:[...new Set(assets.values())],contentsIndexed:false};
}
function rowTitle(type:string,value:(...names:string[])=>string|undefined,category:string,attachments:ReturnType<typeof attachmentInfo>) {
  const name=[value("First Name"),value("Last Name")].filter(Boolean).join(" ");
  if(type==="linkedin-message" || type==="linkedin-invitation") {
    const peers=[value("From"),value("To")].filter(Boolean).map(s=>s!.trim().slice(0,65)).join(" → ");
    const summary=value("Subject","Conversation Title") || value("Content","Message")?.trim().split(/\r?\n/)[0]?.slice(0,70) || (attachments ? `${attachments.count} attachment(s)` : undefined);
    return [peers,summary].filter(Boolean).join(": ") || category;
  }
  if(/^linkedin-recommendations-/.test(type))return `Recommendation ${type.endsWith("received") ? "from" : "for"} ${name}${value("Company") ? " at "+value("Company") : ""}`;
  if(["linkedin-positions","linkedin-job-application","linkedin-saved-jobs"].includes(type))return [value("Title","Job Title"),value("Company Name")].filter(Boolean).join(" at ") || category;
  if(type==="linkedin-post")return postText(value("ShareCommentary") || "").split(/\r?\n/)[0] || category;
  return value("Title","Article Title","Job Title","Content Title","Message","Search Query","Ad Title/Id","FullName","Event Name") || name || value("From","Name","Company","Organization","School Name","Question") || value("Media Description")?.trim().split(/\r?\n/)[0] || category;
}
const proseFields=new Set(["content","sharecommentary","message","text","mediadescription","description","profilesummary","note","question","answer","questionandanswers","searchquery"]);
function rowText(headers:string[],values:string[],type:string,attachments:ReturnType<typeof attachmentInfo>) {
  const fields=headers.map((name,i)=>({name,value:values[i]!,index:i}));
  const prose=fields.some(f=>proseFields.has(key(f.name)) && f.value.trim());
  const sections:TextSection[]=[];let body="";
  const append=(text:string,kind:"primary"|"metadata")=>{const start=body.length;body+=text;sections.push({kind,start,end:body.length});};
  if(type==="linkedin-message" && !prose)append(attachments ? `${attachments.count} ${attachments.kinds.join("/")} attachment(s); no exported message text.\n\n` : "No exported message text.\n\n","metadata");
  fields.sort((a,b)=>Number(proseFields.has(key(b.name)))-Number(proseFields.has(key(a.name))) || a.index-b.index);
  for(const f of fields){if(!f.value)continue;const name=key(f.name);
    const technical=name==="attachments" || /url|link|date|time|conversation|folder|email|phone|ipaddress|useragent|^(?:startedon|finishedon|registeredat|connectedon|sentat|followedon|updatedon)$/.test(name);
    const kind=proseFields.has(name) || !prose && type!=="linkedin-message" && !technical ? "primary" : "metadata";
    const display=name==="attachments" ? `${attachments?.count || 0} attachment(s); contents not indexed` : type==="linkedin-post" && name==="sharecommentary" ? postText(f.value) : f.value;
    append(`${f.name}: `,"metadata");append(display,kind);append("\n\n","metadata");
  }
  return {body:body.trimEnd(),sections:sections.filter(s=>s.start<body.trimEnd().length).map(s=>({...s,end:Math.min(s.end,body.trimEnd().length)}))};
}

export function linkedInRecords(text: string, exportPath: string, entry: string, part: number): RecordData[] {
  text=text.replace(/^\uFEFF/, "");
  const category = basename(entry).replace(/\.csv$/i, "");
  let rows:string[][];
  if(key(category)==="searchqueries" && text.split(/\r?\n/,1)[0]==="Time,Search Query"){
    // LinkedIn writes terminal search text without CSV escaping; quotes and commas are original query text.
    const lines=text.split(/\r?\n/);lines.shift();
    rows=[["Time","Search Query"]];
    for(const line of lines.filter(v=>v.trim())){
      const match=/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} UTC),(.*)$/.exec(line);
      if(!match)fail("INVALID_ARCHIVE",`Malformed LinkedIn search-log row: ${entry}`);
      rows.push([match[1]!,match[2]!]);
    }
  } else rows=parseCsv(text,entry,true);
  let start = rows.findIndex(r => r.some(v => v.trim()));
  if(rows.filter(r=>r.some(v=>v.trim())).length === 1 && rows[start]?.length === 1 && rows[start][0]?.trim() === "No conversations found")return [];
  if (key(category) === "connections") start = rows.findIndex(r => r.some(v => key(v)==="firstname") && r.some(v => key(v)==="lastname"));
  if(start<0) {
    if(rows.some(r=>r.some(v=>v.trim())))fail("INVALID_ARCHIVE",`Missing LinkedIn CSV header: ${entry}`);
    return [];
  }
  const headers = rows[start].map((v,i)=>v.trim() || `Column ${i+1}`);
  if(headers.some((h,i)=>headers.some((other,j)=>j<i && key(other)===key(h) && other!==h)))fail("INVALID_ARCHIVE",`Ambiguous LinkedIn CSV headers: ${entry}`);
  const records:RecordData[]=[];
  for(let i=start+1;i<rows.length;i++) {
    const values=rows[i]; if(!values.some(v=>v.trim()))continue;
    if(values.length!==headers.length)fail("INVALID_ARCHIVE",`Wrong column count in LinkedIn CSV ${entry}, row ${i+1}`);
    // Repeated source columns stay in the body; ambiguous fields are not used as titles, dates or identities.
    const value=(...names:string[])=>names.map(n=>{const columns=headers.flatMap((h,j)=>key(h)===key(n) ? [j] : []);return columns.length===1 ? values[columns[0]!] : undefined;}).find(v=>v?.trim());
    const sourceDateField=[...(key(category)==="positions" ? ["Started On"] : []),"Date","Sent At","Connected On","Registration Date","Registered At","Created At","Creation Date","Date Created","Date Published","Publication Date","Date/Time","Followed On","Updated On","Application Date","Saved Date","CreatedTime","Time","Login Date","Challenge Date","Endorsement Date","Ad clicked Date","Verified date","Creation Time","Content Last Watched Date (if viewed)"].find(n=>value(n));
    const sourceDate=sourceDateField ? value(sourceDateField) : undefined;
    const date=linkedInDate(sourceDate), conversation=key(category)==="messages" ? value("Conversation ID") : undefined;
    const type=linkedInType(entry);
    const attachments=attachmentInfo(value("Attachments")),title=rowTitle(type,value,category,attachments);
    const link=linkedInUrl(value("URL","Profile URL","Sender Profile URL","Article URL","Post URL","Job Posting URL","Job Url","ShareLink","Link"));
    const text=rowText(headers,values,type,attachments);
    records.push(versioned({ref:{source:"linkedin-archive",id:hash(JSON.stringify([part,entry,i+1]))},
      title:title.replace(/\s+/g," ").trim().slice(0,200),...text,
      type,
      locator:exportPath+"#"+encodeURIComponent(entry)+"/row/"+(i+1),observedAt:now(),author:value("From","Sender","Author","Inviter"),
      conversation,occurredAt:date?.occurredAt,
      metadata:{exportPath,entry,category,row:i+1,historical:true,url:type === "linkedin-message" ? undefined : link,profileUrl:type === "linkedin-message" ? link : undefined,sourceDate,sourceDateField,finishedOn:value("Finished On"),dateKind:!date ? "undated" : date.precision === "month" ? "export-calendar-month-sort-key" : date.precision === "day" ? "export-calendar-day" : sourceDateField === "Date/Time" ? "media-upload" : "export-record-date",datePrecision:date?.precision,timezone:date?.precision === "day" || date?.precision === "month" ? "unspecified" : date ? "source-explicit" : undefined,bodyStatus:type==="linkedin-message" ? value("Content")?.trim() ? "text" : attachments ? "attachment-only" : "empty" : undefined,attachments,originalFields:headers.map((name,i)=>({name,value:values[i]}))},
      warnings:sourceDate && !date ? ["Export date has no supported unambiguous date/timezone; retained verbatim, excluded from date-filtered queries."] : date?.precision === "month" ? ["Only the month is known; timestamp is a month-start sort key, not an exact occurrence. Date windows include overlapping months."] : []
    }));
    if(records.length>200_000)fail("SOURCE_LIMIT","LinkedIn CSV exceeds the record budget");
  }
  return records;
}

export function linkedInArticle(text:string,exportPath:string,entry:string,part:number):RecordData {
  const body=/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(text)?.[1];
  if(body===undefined)fail("INVALID_ARCHIVE",`Missing LinkedIn article body: ${entry}`);
  const title=stripHtml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] || basename(entry)).trim();
  const candidate=/<h1\b[^>]*>\s*<a\b[^>]*href="([^"]+)"/i.exec(body)?.[1];
  let url:string|undefined;
  if(candidate)try {const parsed=new URL(candidate);if(parsed.protocol==="https:" && (parsed.hostname==="linkedin.com" || parsed.hostname.endsWith(".linkedin.com")))url=candidate;}catch {}
  const sourceDate=/<p\b[^>]*class="published"[^>]*>Published on ([^<]+)<\/p>/i.exec(body)?.[1];
  const date=linkedInDate(sourceDate),content=readableHtml(body);
  const start=content.indexOf("Published on "),end=start<0 ? -1 : content.indexOf("\n",start);
  return versioned({ref:{source:"linkedin-archive",id:hash(JSON.stringify([part,entry,"article"]))},title:title.slice(0,200),body:content,sections:end<0 ? undefined : [{kind:"metadata",start:0,end:end+1},{kind:"primary",start:end+1,end:content.length}],type:"linkedin-article",locator:exportPath+"#"+encodeURIComponent(entry),observedAt:now(),occurredAt:date?.occurredAt,metadata:{exportPath,entry,category:"Articles",historical:true,url,sourceDate,sourceDateField:"Published on",datePrecision:date?.precision,timezone:date?.precision==="day" ? "unspecified" : date ? "source-explicit" : undefined,dateKind:date?.precision==="day" ? "export-calendar-day" : "export-record-date"},warnings:sourceDate && !date ? ["Unsupported article publication date; retained verbatim, excluded from date-filtered queries."] : []});
}

function linkedInDate(value?:string) {
  if(!value)return undefined;
  let text=value.trim();
  if(/^\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}(?::\d{2})? UTC)?$/.test(text))text=text.replace(/\//g,"-");
  const local=/^(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}(?::\d{2})?$/.exec(text),us=/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:,? \d{1,2}:\d{2} [AP]M)?$/i.exec(text);
  // LinkedIn's M/D/YY export convention uses years since 2000; unknown timezone retains day precision.
  if(local)text=local[1]!;
  if(us)text=`${us[3]!.length===2 ? "20"+us[3] : us[3]}-${us[1]!.padStart(2,"0")}-${us[2]!.padStart(2,"0")}`;
  const month=/^([A-Za-z]{3,9}) (\d{4})$/.exec(text);
  if(month){const names=["january","february","march","april","may","june","july","august","september","october","november","december"],index=names.findIndex(n=>n===month[1]!.toLowerCase() || n.slice(0,3)===month[1]!.toLowerCase());if(index>=0)return {occurredAt:`${month[2]}-${String(index+1).padStart(2,"0")}-01T00:00:00.000Z`,precision:"month"};}
  const upload=/^You uploaded (?:a|an) [a-z ]+ on ([A-Za-z]+ \d{1,2}, \d{4}) at (\d{1,2}:\d{2} [AP]M) \((GMT|UTC)\)$/i.exec(text);
  if(upload)text=`${upload[1]} ${upload[2]} ${upload[3]}`;
  if(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}| UTC)$/i.test(text) || /(?:GMT|UTC|[+-]\d{4})$/i.test(text) || /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} (?:UTC|GMT) \d{4}$/i.test(text)) {
    const normalized=text.replace(/^(\d{4}-\d{2}-\d{2}[T ][\d:.]+) UTC$/i,"$1Z").replace(/^(\d{4}-\d{2}-\d{2}) /,"$1T");
    if(Number.isFinite(Date.parse(normalized)))return {occurredAt:new Date(normalized).toISOString(),precision:"timestamp"};
  }
  if(/^\d{4}-\d{2}-\d{2}$/.test(text) || /^(?:\d{1,2} [A-Za-z]{3,9} \d{4}|[A-Za-z]{3,9} \d{1,2},? \d{4})$/.test(text)) {
    const parsed=Date.parse(text+" 00:00:00 UTC");
    if(Number.isFinite(parsed)) {
      // Calendar-day timestamps are UTC sort keys, not evidence of a time or timezone within that day.
      const occurredAt=new Date(parsed).toISOString();
      if(!/^\d{4}-/.test(text) || occurredAt.slice(0,10)===text)return {occurredAt,precision:"day"};
    }
  }
  return undefined;
}
