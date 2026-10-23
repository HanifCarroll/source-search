import sys,json,tempfile,unittest,zipfile,time
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent.parent/'src'))
from maintenance.documents import pipeline,formats
from extraction_test import fixture_pdf

class RecoveryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);self.cache=self.root/'cache';self.cache.mkdir(mode=0o700)
 def test_books_are_skipped_without_opening_their_content(self):
  p=self.root/'fixture.epub';p.write_bytes(b'not a text document')
  with self.assertRaisesRegex(formats.Skipped,'Book format excluded'):formats.extract(p,self.cache)
 def test_cached_book_text_cannot_bypass_the_exclusion(self):
  p=self.root/'fixture.epub';p.write_bytes(b'invented book')
  item={'path':str(p),'name':p.name,'signature':pipeline.signature(p),'locator':'synthetic://book'}
  cache=pipeline.private_dir(self.cache/'extraction-cache')/(pipeline.digest(item['locator'])+'.json')
  pipeline.save(cache,{'signature':item['signature'],'record':{'body':'Previously extracted synthetic text'}})
  config={'maintenanceEnabled':True,'enabledSources':['documents'],'documentRoots':[],'libraryRoot':str(self.cache)}
  with patch.object(pipeline,'mail_attachments',return_value=([item],[])):
   pipeline.main(config)
  data=json.loads((self.cache/'documents.json').read_text())
  self.assertEqual(data['records'],[]);self.assertEqual(data['failures'],[])
  self.assertIn('Book format excluded',data['skipped'][0]['reason'])
  self.assertNotIn('record',json.loads(cache.read_text()))
 def test_unsupported_binary_is_not_decoded_as_text(self):
  p=self.root/'fixture.bin';p.write_bytes(b'\xff\x00\x01')
  with self.assertRaisesRegex(formats.Skipped,'Unsupported'):formats.extract(p,self.cache)
 def test_gif_is_converted_to_rgb_png_and_cleaned(self):
  from PIL import Image
  p=self.root/'fixture.gif';Image.new('RGBA',(32,32),(0,0,0,0)).save(p)
  def ocr(args,*a,**kw):
   with Image.open(args[1]) as image:self.assertEqual(image.format,'PNG');self.assertEqual(image.mode,'RGB')
   return b'Invented recognized text'
  with patch.object(formats,'command',ocr):self.assertIn('Invented',formats.extract(p,self.cache)[0])
  self.assertFalse(list(self.cache.glob('ocr-*')))
 def test_video_without_audio_is_skipped_before_transcription(self):
  p=self.root/'fixture.mp4';p.write_bytes(b'invented media')
  with patch.object(formats,'command',return_value=b'{"streams":[]}') as run:
   with self.assertRaisesRegex(formats.Skipped,'no audio'):formats.extract(p,self.cache,{'ffprobeBinary':'/synthetic/probe'})
   self.assertEqual(run.call_count,1);self.assertEqual(run.call_args.args[0][0],'/synthetic/probe')
 def test_blank_pdf_has_no_synthetic_heading_as_searchable_text(self):
  p=self.root/'blank.pdf';fixture_pdf(p,[''])
  with patch.object(formats,'command',return_value=b''):self.assertEqual(formats.extract(p,self.cache)[0],'')
 def test_old_failure_retries_once_then_empty_result_is_cached_as_skip(self):
  source=self.root/'source';source.mkdir();p=source/'empty.html';p.write_text('<html><script>hidden</script></html>')
  config={'maintenanceEnabled':True,'enabledSources':['documents'],'documentRoots':[str(source)],'libraryRoot':str(self.cache)}
  store=pipeline.private_dir(self.cache/'extraction-cache')/(pipeline.digest(str(p))+'.json')
  pipeline.save(store,{'signature':pipeline.signature(p),'error':'old failure','retryAt':time.time()+3600})
  pipeline.main(config)
  result=json.loads((self.cache/'documents.json').read_text());self.assertEqual(result['failures'],[]);self.assertEqual(len(result['skipped']),1)
  with patch.object(pipeline,'isolated_extract',side_effect=AssertionError('cached skip was retried')):pipeline.main(config)
if __name__=='__main__':unittest.main()
