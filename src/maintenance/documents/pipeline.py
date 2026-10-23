import json, time, sys
from pathlib import Path
from .common import BASE, TEXT, IMAGE, MEDIA, BOOK_FORMATS, EXTRACTOR_VERSION, Skipped, command, digest, signature, private_dir, save, stamp
from .inventory import inventory, mail_attachments, takeout_attachments

def isolated_extract(path,cache,config):
 payload=json.dumps({'path':str(path),'cache':str(cache),'options':{k:config.get(k) for k in ('tesseractBinary','transcribeBinary','ffprobeBinary','transcriptionBackend','transcriptionModel','ocrLanguages')}}).encode()
 result=json.loads(command([sys.executable,str(Path(__file__).resolve().parents[3]/'scripts/extract-documents.py'),'--worker'],1800 if path.suffix.lower() in MEDIA else 120,input_data=payload))
 if result.get('skipped'):raise Skipped(result['skipped'])
 if result.get('error'):raise ValueError(result['error'])
 return result['body'],result['warnings']

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
  # Policy applies before cache reuse, including entries created by older extractors.
  if Path(item['name']).suffix.lower() in BOOK_FORMATS or Path(item['path']).suffix.lower() in BOOK_FORMATS:
   reason='Book format excluded from document indexing'
   save(stored,{'extractorVersion':EXTRACTOR_VERSION,'signature':item['signature'],'skipped':reason})
   skipped.append({'source':item['locator'],'reason':reason});continue
  # Sidecar changes invalidate a reused transcript too.
  if Path(item['name']).suffix.lower() in MEDIA:
   item['signature'] += [signature(Path(item['path']).with_suffix(ext)) for ext in ('.txt','.srt','.vtt') if Path(item['path']).with_suffix(ext).is_file()]
  item['signature'] += [{k:config.get(k) for k in ('transcriptionBackend','transcriptionModel','ocrLanguages')}]
  if prior and prior.get('signature')==item['signature'] and prior.get('record'):
   records.append(prior['record']);continue
  if prior and prior.get('extractorVersion')==EXTRACTOR_VERSION and prior.get('signature')==item['signature'] and prior.get('skipped'):
   skipped.append({'source':item['locator'],'reason':prior['skipped']});continue
  if time.monotonic()-started>120 or processed>=200:pending+=1;continue
  if prior and prior.get('extractorVersion')==EXTRACTOR_VERSION and prior.get('signature')==item['signature'] and prior.get('retryAt',0)>time.time():failures.append({'source':item['locator'],'error':prior['error']});continue
  processed+=1
  try:
   source=Path(item['path'])
   if source.stat().st_size>250*1024*1024:raise ValueError('File exceeds 250 MB extraction budget')
   body,warnings=isolated_extract(source,cache,config)
   if not body.strip():raise Skipped('No text detected by the extractor; original remains available')
   version=digest(json.dumps(item['signature'])+body)
   record={'ref':{'source':'documents','id':key,'version':version},'title':item['name'],'body':body,'type':'extracted-document','locator':item['locator'],'observedAt':stamp(),'metadata':{'extraction':True,'origin':item,'mailRef':item.get('mailRef')},'warnings':warnings}
   save(stored,{'extractorVersion':EXTRACTOR_VERSION,'signature':item['signature'],'record':record});records.append(record)
  except Skipped as e:
   save(stored,{'extractorVersion':EXTRACTOR_VERSION,'signature':item['signature'],'skipped':str(e)});skipped.append({'source':item['locator'],'reason':str(e)})
  except Exception as e:
   error=type(e).__name__+': '+str(e)[:200];save(stored,{'extractorVersion':EXTRACTOR_VERSION,'signature':item['signature'],'error':error,'retryAt':time.time()+3600});failures.append({'source':item['locator'],'error':error})
 save(root/'documents.json',{'checkedAt':stamp(),'records':records,'failures':failures,'skipped':skipped,'pending':pending,'discovered':len(candidates)})
 print(json.dumps({'documents':len(records),'pending':pending,'failures':len(failures)}))
