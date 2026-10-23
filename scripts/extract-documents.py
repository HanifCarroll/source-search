#!/usr/bin/env python3
"""Private incremental extraction; originals are never modified. No remote content fetches."""
import argparse, hashlib, json, os, stat, subprocess, tempfile, time, zipfile, codecs, mailbox, sys, uuid, resource
from pathlib import Path
from datetime import datetime, timezone

TEXT={'.txt','.html','.htm','.rtf','.doc','.docx','.pdf','.odt','.csv','.tsv','.srt','.vtt'}
IMAGE={'.png','.jpg','.jpeg','.tif','.tiff','.webp','.gif'}
MEDIA={'.mp3','.m4a','.wav','.aac','.flac','.ogg','.opus','.mp4','.mov','.mkv','.webm'}
SUPPORTED=TEXT|IMAGE|MEDIA
HOME=Path.home()
BASE=HOME/'.cache/source-search'
# Bound PDF work; this limit is not a semantic classification of documents.
BOOK_PAGES=100
class Skipped(Exception):pass

def digest(value): return hashlib.sha256(value.encode()).hexdigest()
def stamp(): return datetime.now(timezone.utc).isoformat()
def signature(path):
 s=path.lstat()
 if not stat.S_ISREG(s.st_mode): raise ValueError('Not a regular source file')
 return [str(path),s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_ino]
def private_dir(path):
 path=Path(path)
 for part in [path,*path.parents]:
  if part.is_symlink() and not (sys.platform=='darwin' and str(part) in ('/var','/tmp') and str(part.resolve())=='/private'+str(part)):
   raise ValueError('Cache directory links are not allowed')
 path.mkdir(parents=True,exist_ok=True,mode=0o700)
 if not path.is_dir() or path.stat().st_mode & 0o077:raise ValueError('Cache directory must be private (0700)')
 return path

def save(path,value):
 temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
 try:
  with os.fdopen(os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:json.dump(value,f,ensure_ascii=False)
  temp.replace(path)
 finally:temp.unlink(missing_ok=True)

def child_limits():
 # Disk output and CPU bounds also cover native converter children.
 resource.setrlimit(resource.RLIMIT_FSIZE,(256*1024*1024,256*1024*1024))
 resource.setrlimit(resource.RLIMIT_CPU,(1800,1800))
 if sys.platform=='linux':resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3))

def command(args,timeout=120,input_data=None,max_output=8*1024*1024):
 with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
  p=subprocess.run(args,input=input_data,stdin=subprocess.DEVNULL if input_data is None else None,stdout=out,stderr=err,timeout=timeout,preexec_fn=child_limits,env={**os.environ,'HF_HUB_OFFLINE':'1'})
  if p.returncode:raise RuntimeError(Path(args[0]).name+' failed (exit '+str(p.returncode)+')')
  if out.tell()>max_output:raise ValueError('Command output exceeds extraction budget')
  out.seek(0);return out.read(max_output+1)

def isolated_extract(path,cache,config):
 payload=json.dumps({'path':str(path),'cache':str(cache),'options':{k:config.get(k) for k in ('tesseractBinary','transcribeBinary')}}).encode()
 result=json.loads(command([sys.executable,str(Path(__file__).resolve()),'--worker'],1800 if path.suffix.lower() in MEDIA else 120,input_data=payload))
 if result.get('skipped'):raise Skipped(result['skipped'])
 if result.get('error'):raise ValueError(result['error'])
 return result['body'],result['warnings']

def sniff(data):
 if data.startswith(b'%PDF-'):return '.pdf'
 if data.startswith(b'\x89PNG'):return '.png'
 if data.startswith(b'\xff\xd8\xff'):return '.jpg'
 if data.startswith((b'GIF87a',b'GIF89a')):return '.gif'
 if data[:4]==b'RIFF' and data[8:12]==b'WEBP':return '.webp'
 if data[:4]==b'RIFF' and data[8:12]==b'WAVE':return '.wav'
 if data[4:8]==b'ftyp':return '.mp4'
 if data.startswith(b'OggS'):return '.ogg'
 if data.startswith(b'ID3'):return '.mp3'
 if b'\x00' not in data:
  try:
   text=codecs.getincrementaldecoder('utf8')().decode(data,final=False);return '.txt' if text.strip() else None
  except UnicodeDecodeError:pass
 return None

def extract(path,cache,options=None):
 options=options or {}
 suffix=path.suffix.lower(); warnings=[]
 if suffix in {'.docx','.odt'}:
  with zipfile.ZipFile(path) as z:
   if len(z.infolist())>10000 or sum(i.file_size for i in z.infolist())>250*1024*1024:raise ValueError('Document expansion exceeds extraction budget')
 if suffix=='.pdf':
  import pypdfium2 as pdfium
  parts=[]
  with pdfium.PdfDocument(path) as doc:
   if len(doc)>BOOK_PAGES:raise Skipped(f'PDF exceeds {BOOK_PAGES}-page budget ({len(doc)} pages)')
   for n in range(len(doc)):
    page=doc[n]
    try:
     textpage=page.get_textpage()
     try:text=textpage.get_text_bounded()
     finally:textpage.close()
     if not text.strip():
      scale=180/72
      if page.get_width()*page.get_height()*scale*scale>25_000_000:raise ValueError('PDF page exceeds OCR pixel budget')
      bitmap=page.render(scale=scale);png=cache/f'ocr-{os.getpid()}.png'
      try:
       with bitmap.to_pil() as image:image.save(png)
       text=command([options.get('tesseractBinary') or '/opt/homebrew/bin/tesseract',str(png),'stdout','-l','eng'],180).decode()
      finally:bitmap.close();png.unlink(missing_ok=True)
      warnings.append('OCR used; recognition and reading order require checking against the page')
     parts.append(f'## Page {n+1}\n\n{text}')
    finally:page.close()
  return '\n\n'.join(parts),list(set(warnings))
 if suffix=='.docx':
  from docx import Document
  doc=Document(path);parts=[]
  for item in doc.iter_inner_content():
   if hasattr(item,'text'): parts.append(('# '+item.text) if item.style and item.style.name.startswith('Heading') else item.text)
   else: parts.extend(' | '.join(cell.text for cell in row.cells) for row in item.rows)
  return '\n\n'.join(parts),['Extracted document text; pagination is not inferred']
 if suffix in {'.doc','.rtf','.odt'}:
  return command(['/usr/bin/textutil','-convert','txt','-stdout',str(path)]).decode('utf8'),['Extracted document text; layout may differ']
 if suffix in {'.html','.htm'}:
  from bs4 import BeautifulSoup
  def html(data):
   soup=BeautifulSoup(data,'html.parser')
   for el in soup(['script','style','noscript']):el.decompose()
   for el in soup.find_all(['h1','h2','h3']):el.insert_before('\n'+'#'*int(el.name[1])+' ')
   return soup.get_text('\n',strip=True)
  return html(path.read_bytes()),[]
 if suffix in IMAGE:
  return command([options.get('tesseractBinary') or '/opt/homebrew/bin/tesseract',str(path),'stdout','-l','eng'],180).decode(),['OCR text; recognition errors are possible']
 if suffix in MEDIA:
  # Prefer an existing timestamped transcript adjacent to the source recording.
  for ext in ('.vtt','.srt','.txt'):
   sidecar=path.with_suffix(ext)
   if sidecar.is_file() and not sidecar.is_symlink():return sidecar.read_text(),['Reused adjacent transcript: '+str(sidecar)]
  out=cache/('audio-'+digest(str(path)));private_dir(out)
  command([options.get('transcribeBinary') or str(HOME/'.local/bin/transcribe-audio'),'transcribe',str(path),'--backend','mlx-whisper','--model','large-v3','--formats','txt,json','--output-dir',str(out),'--output-name','transcript','--json'],1800)
  matches=list(out.glob('*.json'))
  if not matches:raise ValueError('Transcription produced no timestamped JSON')
  data=json.loads(matches[0].read_text());segments=data.get('segments',[])
  if not segments:raise ValueError('No timestamped transcript segments returned')
  return '\n'.join(f'[{s.get("start",0):.1f}s–{s.get("end",0):.1f}s] {s.get("text","")}' for s in segments),['Automatic local transcription; speaker identities are not inferred; check important wording against recording']
 return path.read_text(encoding='utf8'),[]

def inventory(config):
 candidates=[];skipped=[];seen=set()
 for root in config.get('documentRoots',[]):
  root=Path(root)
  if not root.is_dir() or root.is_symlink():raise ValueError('Configured document root is unavailable')
  for base,dirs,files in os.walk(root,followlinks=False,onerror=lambda e:(_ for _ in ()).throw(e)):
   dirs[:]=[d for d in dirs if not d.startswith('.') and d not in ('node_modules','venv','__pycache__') and not Path(base,d).is_symlink()]
   for name in files:
    p=Path(base,name)
    # Data tables in configured folders are not prose; mail CSV attachments are still extracted.
    if name.startswith('.') or p.is_symlink() or p.suffix.lower() not in SUPPORTED or p.suffix.lower() in {'.csv','.tsv'}:continue
    if str(p) in seen:continue
    seen.add(str(p));candidates.append({'path':str(p),'name':name,'signature':signature(p),'locator':str(p)})
 # Exports contribute their content records through the structured readers; files inside them are not extracted.
 return candidates,skipped

def mail_attachments(config,root):
 candidates=[];failures=[];downloads=root/'attachments';private_dir(downloads)
 for rawfile in sorted((root/'mail-raw').glob('*.json')):
  try:
   item=json.loads(rawfile.read_text());source=item['source'];mid=item['id'];raw=item['raw']
   if source not in config.get('enabledSources',[]):continue
   account=config.get('mailAccounts',{}).get(source)
   if not account:raise ValueError('Mail account is not configured')
   folder=downloads/(source+'-'+mid);private_dir(folder)
   manifest=folder/'manifest.json'
   cached=json.loads(manifest.read_text()) if manifest.exists() else {}
   parent_signature=signature(rawfile)
   if not isinstance(cached,dict) or cached.get('parent')!=parent_signature:
    entries=[]
    if source=='mail-fastmail':
     supported=[a for a in raw.get('attachments',[]) if Path(a.get('filename','')).suffix.lower() in SUPPORTED]
     if supported:
      if sum(a.get('size_bytes') or 0 for a in raw.get('attachments',[]))>250*1024*1024:raise ValueError('Message attachments exceed download byte budget')
      data=json.loads(command([config['mailbridgeBinary'],'--json','attachments','download','--account',account['account'],'--message-id',mid,'--out',str(folder)],120))
      entries=[{'path':a['output_path'],'name':a['filename']} for a in data.get('attachments',[]) if Path(a['filename']).suffix.lower() in SUPPORTED]
    else:
     def parts(node):
      yield node
      for child in node.get('parts',[]):yield from parts(child)
     for part in parts(raw.get('message',{}).get('payload',{})):
      name=part.get('filename','');body=part.get('body',{});ext=Path(name).suffix.lower()
      if ext not in SUPPORTED:continue
      if body.get('size',0)>250*1024*1024:raise ValueError('Attachment exceeds download byte budget')
      target=folder/(digest(name+str(part.get('partId')))+ext)
      if body.get('attachmentId'):
       command([config['gmailBinary'],'gmail','attachment',mid,body['attachmentId'],'--account',account['account'],'--gmail-no-send','--json','--no-input','--out',str(target)],120)
      elif body.get('data'):
       import base64
       target.write_bytes(base64.urlsafe_b64decode(body['data']+'==='))
      else:continue
      entries.append({'path':str(target),'name':name})
    save(manifest,{'parent':parent_signature,'entries':entries})
   for entry in json.loads(manifest.read_text())['entries']:
    p=Path(entry['path']);sig=signature(p)+[parent_signature]
    candidates.append({**entry,'signature':sig,'locator':'source-search://'+source+'/'+mid+'#attachment/'+entry['name'],'mailRef':item.get('ref',{'source':source,'id':mid}),'guardPath':str(rawfile),'guardSignature':signature(rawfile),'accountSignature':item.get('accountSignature')})
  except Exception as e:failures.append({'source':rawfile.name,'error':type(e).__name__+': '+str(e)[:160]})
 return candidates,failures

def takeout_attachments(config,root):
 candidates=[];failures=[];folder=root/'takeout-attachments';private_dir(folder)
 for archive in (config.get('takeout',[]) if 'takeout-archive' in config.get('enabledSources',[]) else []):
  p=Path(archive);parent=signature(p);manifest=folder/(digest(str(p))+'.json')
  prior=json.loads(manifest.read_text()) if manifest.exists() else {}
  try:
   if prior.get('parent')!=parent:
    entries=[]
    with zipfile.ZipFile(p) as z:
     if len(z.infolist())>100000 or sum(e.file_size for e in z.infolist())>4*1024**3:raise ValueError("Archive expansion exceeds extraction budget")
     for entry in z.infolist():
      if not entry.filename.lower().endswith('.mbox'):continue
      if entry.file_size>768*1024*1024:raise ValueError('MBOX exceeds existing archive reader budget')
      with tempfile.TemporaryDirectory(dir=folder) as work:
       target=Path(work)/'messages.mbox'
       # Stream the selected container into the private cache; no source extraction writes.
       with z.open(entry) as src,target.open('wb') as dest:
        import shutil
        shutil.copyfileobj(src,dest,1024*1024)
       box=mailbox.mbox(target,create=False)
       try:
        for index,message in enumerate(box):
         for part_index,part in enumerate(message.walk()):
          name=part.get_filename()
          if not name or part.is_multipart():continue
          payload=part.get_payload(decode=True)
          if not payload:continue
          ext=Path(name).suffix.lower()
          if ext not in SUPPORTED:ext=sniff(payload[:4096])
          if ext not in SUPPORTED:continue
          if len(payload)>250*1024*1024:raise ValueError('MBOX attachment exceeds extraction budget')
          identity=str(p)+'#'+entry.filename+'/message/'+str(index)+'/attachment/'+str(part_index)
          out=folder/(digest(identity)+ext);out.write_bytes(payload)
          entries.append({'path':str(out),'name':name,'signature':parent+[entry.CRC,index,part_index,hashlib.sha256(payload).hexdigest()],'locator':identity,'source':'takeout-archive','messageId':message.get('Message-ID')})
       finally:box.close()
    save(manifest,{'parent':parent,'entries':entries})
   candidates.extend(json.loads(manifest.read_text())['entries'])
  except Exception as e:failures.append({'source':str(p),'error':type(e).__name__+': '+str(e)[:180]})
 return candidates,failures

def main(config):
 if not config.get('maintenanceEnabled') or 'documents' not in config.get('enabledSources',[]):raise ValueError('Document maintenance is disabled')
 root=Path(config.get('libraryRoot',str(BASE/'library')));private_dir(root);cache=private_dir(root/'extraction-cache')
 candidates,skipped=inventory(config);mail,failures=mail_attachments(config,root);candidates+=mail
 takeout,archive_failures=takeout_attachments(config,root);candidates+=takeout;failures+=archive_failures
 prior_cache={}
 for item in candidates:
  key=digest(item['locator']);stored=cache/(key+'.json')
  if stored.exists():prior_cache[key]=json.loads(stored.read_text())
 # New/changed inputs take precedence over retries, so failed OCR cannot starve a backfill.
 candidates.sort(key=lambda item: (bool(prior_cache.get(digest(item['locator']),{}).get('error')), 0 if Path(item['name']).suffix.lower() in TEXT else 1 if Path(item['name']).suffix.lower() in IMAGE else 2))
 records=[];pending=0;started=time.monotonic();processed=0
 for item in candidates:
  key=digest(item['locator']);stored=cache/(key+'.json');prior=prior_cache.get(key)
  # Sidecar changes invalidate a reused transcript too.
  if Path(item['name']).suffix.lower() in MEDIA:
   item['signature'] += [signature(Path(item['path']).with_suffix(ext)) for ext in ('.txt','.srt','.vtt') if Path(item['path']).with_suffix(ext).is_file()]
  if prior and prior.get('signature')==item['signature'] and prior.get('record'):
   records.append(prior['record']);continue
  if prior and prior.get('signature')==item['signature'] and prior.get('skipped'):
   skipped.append({'source':item['locator'],'reason':prior['skipped']});continue
  if time.monotonic()-started>120 or processed>=200:pending+=1;continue
  if prior and prior.get('signature')==item['signature'] and prior.get('retryAt',0)>time.time():failures.append({'source':item['locator'],'error':prior['error']});continue
  processed+=1
  try:
   source=Path(item['path'])
   if source.stat().st_size>250*1024*1024:raise ValueError('File exceeds 250 MB extraction budget')
   body,warnings=isolated_extract(source,cache,config)
   if not body.strip():raise ValueError('No readable text was extracted')
   version=digest(json.dumps(item['signature'])+body)
   record={'ref':{'source':'documents','id':key,'version':version},'title':item['name'],'body':body,'type':'extracted-document','locator':item['locator'],'observedAt':stamp(),'metadata':{'extraction':True,'origin':item,'mailRef':item.get('mailRef')},'warnings':warnings}
   save(stored,{'signature':item['signature'],'record':record});records.append(record)
  except Skipped as e:
   save(stored,{'signature':item['signature'],'skipped':str(e)});skipped.append({'source':item['locator'],'reason':str(e)})
  except Exception as e:
   error=type(e).__name__+': '+str(e)[:200];save(stored,{'signature':item['signature'],'error':error,'retryAt':time.time()+3600});failures.append({'source':item['locator'],'error':error})
 save(root/'documents.json',{'checkedAt':stamp(),'records':records,'failures':failures,'skipped':skipped,'pending':pending,'discovered':len(candidates)})
 print(json.dumps({'documents':len(records),'pending':pending,'failures':len(failures)}))

if __name__=='__main__':
 os.umask(0o077);os.environ['PATH']='/opt/homebrew/bin:'+str(HOME/'.local/bin')+':'+os.environ.get('PATH','')
 # Installed model only: maintenance cannot silently fetch a new model.
 os.environ['HF_HUB_OFFLINE']='1'
 parser=argparse.ArgumentParser();parser.add_argument('--config');parser.add_argument('--worker',action='store_true');args=parser.parse_args()
 if args.worker:
  try:
   item=json.loads(sys.stdin.buffer.read(65537));body,warnings=extract(Path(item['path']),Path(item['cache']),item['options'])
   if len(body.encode())>4*1024*1024:raise ValueError('Extracted text exceeds 4 MB budget')
   print(json.dumps({'body':body,'warnings':warnings}))
  except Skipped as e:print(json.dumps({'skipped':str(e)}))
  except Exception as e:print(json.dumps({'error':type(e).__name__+': '+str(e)[:200]}))
 elif args.config:main(json.loads(Path(args.config).read_text()))
 else:parser.error('--config is required')
