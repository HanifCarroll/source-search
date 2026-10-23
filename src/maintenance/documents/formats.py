import codecs, json, os, zipfile, uuid, shutil
from pathlib import Path
from .common import TEXT, IMAGE, MEDIA, BOOK_FORMATS, HOME, BOOK_PAGES, Skipped, command, digest, private_dir, signature

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

def html_text(data):
 from bs4 import BeautifulSoup
 soup=BeautifulSoup(data,'html.parser')
 for el in soup(['script','style','noscript']):el.decompose()
 for el in soup.find_all(['h1','h2','h3']):el.insert_before('\n'+'#'*int(el.name[1])+' ')
 return soup.get_text('\n',strip=True)

def extract(path,cache,options=None):
 options=options or {}
 suffix=path.suffix.lower(); warnings=[]
 if suffix in BOOK_FORMATS:raise Skipped('Book format excluded from document indexing')
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
       text=command([options.get('tesseractBinary') or shutil.which('tesseract') or 'tesseract',str(png),'stdout','-l',options.get('ocrLanguages') or 'eng'],180).decode()
      finally:bitmap.close();png.unlink(missing_ok=True)
      warnings.append('OCR used; recognition and reading order require checking against the page')
     if text.strip():parts.append(f'## Page {n+1}\n\n{text}')
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
 if suffix in {'.html','.htm'}:return html_text(path.read_bytes()),[]
 if suffix in IMAGE:
  from PIL import Image, ImageSequence
  parts=[];png=cache/f'ocr-{os.getpid()}-{uuid.uuid4().hex}.png'
  try:
   with Image.open(path) as image:
    if image.width*image.height>25_000_000:raise ValueError('Image exceeds OCR pixel budget')
    if getattr(image,'n_frames',1)>100:raise ValueError('Image exceeds 100-frame OCR budget')
    for frame in ImageSequence.Iterator(image):
     # Tesseract does not accept GIF directly; composite transparency onto white.
     with frame.convert('RGBA') as rgba,Image.new('RGB',frame.size,'white') as rgb:
      rgb.paste(rgba,mask=rgba.getchannel('A'));rgb.save(png)
     text=command([options.get('tesseractBinary') or shutil.which('tesseract') or 'tesseract',str(png),'stdout','-l',options.get('ocrLanguages') or 'eng'],180).decode()
     if text.strip() and text not in parts:parts.append(text)
  finally:png.unlink(missing_ok=True)
  return '\n\n'.join(parts),['OCR text; recognition errors are possible']
 if suffix in MEDIA:
  # Prefer an existing timestamped transcript adjacent to the source recording.
  for ext in ('.vtt','.srt','.txt'):
   sidecar=path.with_suffix(ext)
   if sidecar.is_file() and not sidecar.is_symlink():return sidecar.read_text(),['Reused adjacent transcript: '+str(sidecar)]
  streams=json.loads(command([options.get('ffprobeBinary') or shutil.which('ffprobe') or 'ffprobe','-v','error','-select_streams','a','-show_entries','stream=index','-of','json',str(path)]))
  if not streams.get('streams'):raise Skipped('Media has no audio stream to transcribe')
  if not options.get('transcriptionBackend') or not options.get('transcriptionModel'):raise Skipped('Set transcriptionBackend and transcriptionModel to transcribe audio without a sidecar')
  out=cache/('audio-'+digest(json.dumps(signature(path)))) ;private_dir(out)
  command([options.get('transcribeBinary') or shutil.which('transcribe-audio') or 'transcribe-audio','transcribe',str(path),'--backend',options['transcriptionBackend'],'--model',options['transcriptionModel'],'--formats','txt,json','--output-dir',str(out),'--output-name','transcript','--json'],1800)
  matches=list(out.glob('*.json'))
  if not matches:raise ValueError('Transcription produced no timestamped JSON')
  data=json.loads(matches[0].read_text());segments=data.get('segments',[])
  if not segments:raise ValueError('No timestamped transcript segments returned')
  return '\n'.join(f'[{s.get("start",0):.1f}s–{s.get("end",0):.1f}s] {s.get("text","")}' for s in segments),['Automatic local transcription; speaker identities are not inferred; check important wording against recording']
 if suffix not in TEXT:raise Skipped('Unsupported document format: '+suffix)
 return path.read_text(encoding='utf-8-sig'),[]
