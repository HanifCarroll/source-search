import hashlib, json, os, stat, subprocess, tempfile, sys, uuid, resource
from pathlib import Path
from datetime import datetime, timezone
TEXT={'.txt','.html','.htm','.rtf','.doc','.docx','.pdf','.odt','.csv','.tsv','.srt','.vtt'}
IMAGE={'.png','.jpg','.jpeg','.tif','.tiff','.webp','.gif'}
MEDIA={'.mp3','.m4a','.wav','.aac','.flac','.ogg','.opus','.mp4','.mov','.mkv','.webm'}
SUPPORTED=TEXT|IMAGE|MEDIA
BOOK_FORMATS={'.epub','.mobi','.azw','.azw3','.fb2','.djvu'}
HOME=Path.home()
BASE=HOME/'.cache/source-search'
# Bound PDF work; this limit is not a semantic classification of documents.
BOOK_PAGES=100
EXTRACTOR_VERSION=3
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
