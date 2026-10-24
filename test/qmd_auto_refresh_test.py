import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os
import subprocess
import threading
import time

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

    def test_executables_follow_path_and_explicit_overrides(self):
        import os
        from unittest.mock import patch
        binary=self.root/'qmd';binary.write_text('#!/bin/sh\nexit 0\n');binary.chmod(0o700)
        with patch.dict(os.environ, {'PATH':str(self.root)}):
            self.assertEqual(m.executable({}, 'qmdBinary', 'qmd'),str(binary))
            self.assertEqual(m.executable({'qmdBinary':'/custom/qmd'}, 'qmdBinary', 'qmd'),'/custom/qmd')
            with self.assertRaisesRegex(RuntimeError,'absolute'):m.executable({'qmdBinary':'relative/qmd'}, 'qmdBinary', 'qmd')
            with self.assertRaisesRegex(RuntimeError,'PATH'):m.executable({}, 'nodeBinary', 'node')

if __name__=='__main__':unittest.main()

class NamedRefreshTests(unittest.TestCase):
 def test_named_vaults_and_library_only_are_independent(self):
  with tempfile.TemporaryDirectory() as work:
   root=Path(work);notes=root/'notes';notes.mkdir();(notes/'note.md').write_text('Invented note')
   config={'maintenanceEnabled':True,'enabledSources':['research','library'],'sources':{'research':{'adapter':'vault','roots':{'notes':str(notes)}}},'libraryEnabled':True}
   self.assertEqual(m.snapshot(config)[1],1)
   self.assertEqual(list(m.vault_roots(config)),['research/notes'])
   config['enabledSources']=['library']
   self.assertEqual(m.vault_roots(config),{})
   path=root/'config.json';path.write_text(json.dumps(config));calls=[]
   worker=m.Refresher(path,root/'state',lambda c:calls.append(c));worker.step(0);worker.step(60)
   self.assertEqual(calls,[])


class IndependentMaintenanceTests(unittest.TestCase):
 def test_keyword_indexing_has_no_embedding_step_and_library_reuses_snapshots(self):
  self.assertEqual(m.index_commands({}), [(['index'], 600)])
  self.assertEqual(m.index_commands({}, library=True), [(['index', '--library', '--skip-source-sync'], 3600)])
  for config in [{'searchModels': {'embed': '/embed', 'rerank': '/rerank', 'generate': '/generate'}}, {'qmdModels': ['/embed', '/rerank', '/generate']}]:
   self.assertEqual(m.index_commands(config)[1], (['index', '--embed-only'], 1800))
   self.assertEqual(m.index_commands(config, library=True)[1], (['index', '--library', '--embed-only'], 1800))

 def test_periodic_failures_and_disabled_stages_do_not_prevent_source_refresh(self):
  with tempfile.TemporaryDirectory() as work:
   root=Path(work);config=root/'config.json'
   config.write_text(json.dumps({'maintenanceEnabled': True, 'enabledSources': ['todo']}))
   def failed(c): raise RuntimeError('Invented index failure')
   m.periodic_refresh(config, root, 'library', lambda c: True, failed)
   calls=[]
   m.periodic_refresh(config, root, 'sources', lambda c: True, lambda c: calls.append(c))
   self.assertEqual(len(calls), 1)
   self.assertEqual(json.loads((root/'library-status.json').read_text())['state'], 'error')
   self.assertEqual(json.loads((root/'sources-status.json').read_text())['state'], 'idle')
   config.write_text(json.dumps({'maintenanceEnabled': False}))
   m.periodic_refresh(config, root, 'sources', lambda c: True, lambda c: self.fail('disabled refresh'))
   self.assertEqual(json.loads((root/'sources-status.json').read_text())['state'], 'disabled')

 def test_command_timeout_terminates_child_and_later_commands_can_run(self):
  with tempfile.TemporaryDirectory() as work:
   root=Path(work);binary=root/'invented-bun'
   binary.write_text('#!'+sys.executable+'\nimport sys,time\nif sys.argv[-1]=="slow": time.sleep(30)\n')
   binary.chmod(0o700)
   runner=m.CommandRunner(root/'config.json',root,threading.Event())
   with self.assertRaisesRegex(RuntimeError,'timed out'):
    runner.run({'bunBinary': str(binary)}, [(['slow'], 0.01)], 'fixture')
   self.assertIsNone(runner.child)
   runner.run({'bunBinary': str(binary)}, [(['fast'], 2)], 'fixture')
   runner.stopping.set()
   with self.assertRaisesRegex(RuntimeError,'interrupted'):
    runner.run({'bunBinary': str(binary)}, [(['fast'], 2)], 'fixture')

 def test_source_worker_can_finish_while_library_waits_and_shutdown_is_clean(self):
  with tempfile.TemporaryDirectory() as work:
   root=Path(work);binary=root/'invented-bun';config=root/'config.json';state=root/'state'
   # Neither command can finish unless source sync and indexing run independently.
   binary.write_text('#!'+sys.executable+'''\nimport sys,time
from pathlib import Path
root=Path(__file__).parent
source=sys.argv[2]=='sync-sources'
(root/('sources-started' if source else 'index-started')).touch()
waiting=root/('index-started' if source else 'sources-finished')
deadline=time.monotonic()+5
while not waiting.exists() and time.monotonic()<deadline: time.sleep(0.01)
if not waiting.exists(): sys.exit(9)
if source: (root/'sources-finished').touch()
if '--embed-only' in sys.argv: sys.exit(10)
''')
   binary.chmod(0o700)
   config.write_text(json.dumps({'maintenanceEnabled':True,'libraryEnabled':True,'enabledSources':['todo','library'],'bunBinary':str(binary)}))
   script=Path(__file__).resolve().parent.parent/'scripts/qmd-auto-refresh.py'
   process=subprocess.Popen([sys.executable,str(script),'--config',str(config),'--state-dir',str(state)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
   try:
    deadline=time.monotonic()+8
    while time.monotonic()<deadline:
     try:
      if all(json.loads((state/(name+'-status.json')).read_text())['state']=='idle' for name in ['sources','library']): break
     except (FileNotFoundError,ValueError): pass
     time.sleep(0.05)
    self.assertEqual(json.loads((state/'sources-status.json').read_text())['state'],'idle')
    self.assertEqual(json.loads((state/'library-status.json').read_text())['state'],'idle')
    self.assertTrue((root/'sources-finished').exists())
    self.assertNotIn('--embed-only',(state/'library-refresh.log').read_text())
   finally:
    process.terminate()
    try: _,errors=process.communicate(timeout=3)
    except subprocess.TimeoutExpired:
     process.kill();process.communicate();self.fail('Refresh did not shut down')
   self.assertEqual(process.returncode,0,errors.decode())
