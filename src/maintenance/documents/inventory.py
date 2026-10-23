import hashlib, json, os, tempfile, zipfile, mailbox
from collections import Counter
from pathlib import Path
from .common import SUPPORTED, BOOK_FORMATS, command, signature, private_dir, digest, save
from .formats import sniff

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
   entries=list({(entry['path'],entry['name']):entry for entry in json.loads(manifest.read_text())['entries']}.values())
   names=Counter(entry['name'] for entry in entries)
   for entry in entries:
    p=Path(entry['path']);sig=signature(p)+[parent_signature]
    suffix='attachment/'+entry['name'] if names[entry['name']]==1 else 'attachment-id/'+digest(str(p))+'/'+entry['name']
    candidates.append({**entry,'signature':sig,'locator':'source-search://'+source+'/'+mid+'#'+suffix,'mailRef':item.get('ref',{'source':source,'id':mid}),'guardPath':str(rawfile),'guardSignature':signature(rawfile),'accountSignature':item.get('accountSignature')})
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
          if ext in BOOK_FORMATS:continue
          if ext not in SUPPORTED:ext=sniff(payload[:4096])
          if ext not in SUPPORTED:continue
          if len(payload)>250*1024*1024:raise ValueError('MBOX attachment exceeds extraction budget')
          identity=str(p)+'#'+entry.filename+'/message/'+str(index)+'/attachment/'+str(part_index)
          out=folder/(digest(identity)+ext);out.write_bytes(payload)
          entries.append({'path':str(out),'name':name,'signature':parent+[entry.CRC,index,part_index,hashlib.sha256(payload).hexdigest()],'locator':identity,'source':'takeout-archive','messageId':message.get('Message-ID')})
       finally:box.close()
    save(manifest,{'parent':parent,'entries':entries})
   candidates.extend({**entry,'source':'takeout-archive'} for entry in json.loads(manifest.read_text())['entries'])
  except Exception as e:failures.append({'source':str(p),'error':type(e).__name__+': '+str(e)[:180]})
 return candidates,failures
