import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'src'))
from maintenance import refresh as m

class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.notes = self.root/'notes'; self.notes.mkdir()
        self.config = self.root/'config.json'; self.config.write_text(json.dumps({'maintenanceEnabled':True,'enabledSources':['vault'],'qmdRoots': {'notes': str(self.notes)}}))
        self.calls = []
        self.w = m.Refresher(self.config, self.root/'state', lambda c: self.calls.append(c))
    def tick(self, a, b):
        self.w.step(a); self.w.step(b)
    def test_debounce_add_edit_delete_and_restart(self):
        self.tick(0, 30); self.assertEqual(len(self.calls), 1)
        f=self.notes/'invented.md'; f.write_text('Invented first version')
        self.w.step(60); f.write_text('Invented second version'); self.w.step(80)
        self.w.step(100); self.assertEqual(len(self.calls),1)
        self.w.step(110); self.assertEqual(len(self.calls),2)
        f.unlink(); self.tick(120,150); self.assertEqual(len(self.calls),3)
        restarted=m.Refresher(self.config,self.root/'state',lambda c:self.fail('unchanged restart ran refresh'))
        restarted.step(0)
        f.write_text('Changes while stopped'); self.tick(180,210); self.assertEqual(len(self.calls),4)
    def test_failure_retries_without_recording_success(self):
        self.tick(0,30); old=self.w.completed
        (self.notes/'invented.md').write_text('synthetic')
        def fail(c): raise RuntimeError('synthetic embedding failure')
        self.w.runner=fail; self.tick(60,90)
        self.assertEqual(self.w.completed,old)
        self.assertEqual(json.loads((self.root/'state/status.json').read_text())['state'],'error')
        self.w.runner=lambda c:self.calls.append(c)
        self.w.step(120); self.assertEqual(len(self.calls),1)
        self.w.step(150); self.assertEqual(len(self.calls),2)
    def test_edits_during_refresh_are_not_lost(self):
        self.tick(0,30); f=self.notes/'invented.md'; f.write_text('before')
        self.w.runner=lambda c:(self.calls.append(c),f.write_text('during'))
        self.tick(60,90); self.w.runner=lambda c:self.calls.append(c)
        self.tick(120,150); self.assertEqual(len(self.calls),3)
    def test_missing_root_defers_instead_of_deleting_index(self):
        self.tick(0,30); self.notes.rmdir(); self.w.step(60)
        self.assertEqual(len(self.calls),1)
        self.assertEqual(json.loads((self.root/'state/status.json').read_text())['state'],'error')
    def test_links_and_non_markdown_do_not_trigger_refresh(self):
        self.tick(0,30); (self.notes/'ignored.txt').write_text('synthetic')
        (self.notes/'linked.md').symlink_to(self.notes/'ignored.txt'); self.tick(60,90)
        self.assertEqual(len(self.calls),1)
    def test_icloud_placeholders_are_downloaded_before_update(self):
        note=self.notes/'placeholder.md'; note.write_text('Invented placeholder')
        placeholders={note}; downloads=[]
        def download(path): downloads.append(path); placeholders.discard(path)
        m.materialize({'maintenanceEnabled':True,'enabledSources':['vault'],'qmdRoots': {'notes': str(self.notes)}}, download=download, is_dataless=lambda p: p in placeholders, sleep=lambda s: None)
        self.assertEqual(downloads,[note])
        placeholders.add(note)
        with self.assertRaisesRegex(RuntimeError,'placeholder.md'):
            m.materialize({'maintenanceEnabled':True,'enabledSources':['vault'],'qmdRoots': {'notes': str(self.notes)}}, timeout=0, download=lambda p: None, is_dataless=lambda p: p in placeholders, sleep=lambda s: None)

    def test_disabled_configuration_does_not_scan_or_refresh(self):
        self.config.write_text(json.dumps({'qmdRoots':{'fixture':'/does-not-exist'}}))
        self.tick(0,30)
        self.assertEqual(self.calls,[])
        self.assertEqual(json.loads((self.root/'state/status.json').read_text())['state'],'disabled')

if __name__=='__main__':unittest.main()
