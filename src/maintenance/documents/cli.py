import argparse, json, os, sys
from pathlib import Path
from .common import HOME, Skipped
from .formats import extract
from .pipeline import main as run_pipeline

def main():
 os.umask(0o077)
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
 elif args.config:run_pipeline(json.loads(Path(args.config).read_text()))
 else:parser.error('--config is required')
