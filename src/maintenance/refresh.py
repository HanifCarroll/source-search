#!/usr/bin/python3
"""Refresh the private QMD index after stable changes; never edit originals."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import stat
import subprocess
import threading
import time


def executable(config, key, name):
    path = config.get(key) or shutil.which(name)
    if not path or not Path(path).is_absolute():
        raise RuntimeError('Configure an absolute ' + key + ' path or put ' + name + ' on PATH')
    return path


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def snapshot(config):
    roots = config.get('qmdRoots', {})
    if not roots:
        raise RuntimeError('No QMD collection roots configured')
    digest = hashlib.sha256(json.dumps({k: config.get(k) for k in ('qmdRoots', 'qmdIndex', 'qmdBinary')}, sort_keys=True).encode())
    count = 0
    for collection, root in sorted(roots.items()):
        root = Path(root)
        if not root.is_dir() or root.is_symlink():
            raise RuntimeError('A configured collection is unavailable; refresh deferred')
        def scan_error(error):
            raise error
        for base, directories, files in os.walk(root, followlinks=False, onerror=scan_error):
            directories[:] = sorted(d for d in directories if not d.startswith('.') and not Path(base, d).is_symlink())
            for name in sorted(files):
                if name.startswith('.') or not name.endswith('.md'):
                    continue
                path = Path(base, name)
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode):
                    continue
                # Stat detects edits/atomic replacements without downloading unchanged
                # iCloud files. QMD hashes actual contents during its incremental update.
                digest.update(json.dumps([collection, str(path.relative_to(root)), info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino]).encode())
                count += 1
    return digest.hexdigest(), count


SF_DATALESS = 0x40000000  # iCloud placeholder whose contents are not on this Mac


def materialize(config, timeout=60, download=None, is_dataless=None, sleep=time.sleep):
    """Download iCloud placeholders first; QMD's read fails with error -11 on them."""
    download = download or (lambda path: subprocess.run(['/usr/bin/brctl', 'download', str(path)], stdin=subprocess.DEVNULL, capture_output=True, timeout=30))
    is_dataless = is_dataless or (lambda path: bool(getattr(path.lstat(), 'st_flags', 0) & SF_DATALESS))
    waiting = []
    for root in config.get('qmdRoots', {}).values():
        for base, directories, files in os.walk(root, followlinks=False):
            directories[:] = [d for d in directories if not d.startswith('.') and not Path(base, d).is_symlink()]
            waiting += [Path(base, name) for name in files if name.endswith('.md') and not name.startswith('.') and is_dataless(Path(base, name))]
    for path in waiting:
        download(path)
    deadline = time.monotonic() + timeout
    while waiting and time.monotonic() < deadline:
        sleep(2)
        waiting = [path for path in waiting if is_dataless(path)]
    if waiting:
        raise RuntimeError('iCloud has not downloaded ' + ', '.join(str(p) for p in waiting[:3]) + '; refresh will retry')


class Refresher:
    def __init__(self, config_path, state_dir, runner, quiet=30):
        self.config_path, self.state_dir, self.runner = Path(config_path), Path(state_dir), runner
        self.quiet = quiet
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            self.completed = json.loads((self.state_dir / 'completed.json').read_text())['signature']
        except (FileNotFoundError, KeyError, ValueError):
            self.completed = None
        self.pending = None
        self.changed_at = 0
        self.retry_at = 0
        self.failures = 0

    def status(self, **values):
        save(self.state_dir / 'status.json', {'checkedAt': stamp(), **values})

    def step(self, now):
        if now < self.retry_at:
            return
        try:
            config = json.loads(self.config_path.read_text())
            if not config.get('maintenanceEnabled') or 'vault' not in config.get('enabledSources',[]):
                self.status(state='disabled');return
            signature, count = snapshot(config)
            if signature == self.completed:
                self.pending = None
                self.status(state='idle', documents=count)
                return
            if signature != self.pending:
                self.pending, self.changed_at = signature, now
            if now - self.changed_at < self.quiet:
                self.status(state='waiting-for-edits-to-settle', documents=count)
                return
            self.status(state='refreshing', documents=count)
            self.runner(config)
            # Save the pre-refresh signature so edits made DURING refresh trigger
            # another pass. Never mark a failed embedding run as completed.
            save(self.state_dir / 'completed.json', {'signature': signature, 'completedAt': stamp(), 'documents': count})
            self.completed, self.pending, self.failures, self.retry_at = signature, None, 0, 0
            self.status(state='idle', documents=count, lastRefreshCompletedAt=stamp())
        except Exception as error:
            self.failures += 1
            delay = min(300, 30 * 2 ** min(self.failures, 4))
            self.retry_at = now + delay
            self.status(state='error', error=str(error)[:500], retryInSeconds=delay)


def run(config_path, state_dir):
    state_dir = Path(state_dir)
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (state_dir / 'watcher.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    stopping = threading.Event()
    child = None

    def stop(_signum, _frame):
        stopping.set()
        if child and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def refresh(config):
        nonlocal child
        binary = executable(config, 'qmdBinary', 'qmd')
        index = config.get('qmdIndex', 'source-search')
        if not Path(binary).is_absolute():
            raise RuntimeError('QMD binary must be an absolute path')
        log = state_dir / 'refresh.log'
        if log.exists() and log.stat().st_size > 2 * 1024 * 1024:
            os.replace(log, state_dir / 'refresh.previous.log')
        if not config.get('maintenanceEnabled') or 'vault' not in config.get('enabledSources',[]):
            raise RuntimeError('Vault maintenance is disabled')
        materialize(config)
        with log.open('a') as output:
            for command, timeout in [('update', 600), ('embed', 1800)]:
                if stopping.is_set():
                    raise RuntimeError('Refresh interrupted; will resume after restart')
                output.write('\n' + stamp() + ' QMD ' + command + '\n'); output.flush()
                child = subprocess.Popen([binary, '--index', index, command], stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True, env={**os.environ,"SOURCE_SEARCH_CONFIG_FILE":str(config_path)})
                try:
                    code = child.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL); child.wait()
                    raise RuntimeError('QMD ' + command + ' timed out')
                finally:
                    child = None
                if code:
                    raise RuntimeError('QMD ' + command + ' failed (exit ' + str(code) + '); see private refresh.log')
    def library_refresh(config):
        nonlocal child
        if not config.get('maintenanceEnabled') or 'library' not in config.get('enabledSources',[]):
            return
        log = state_dir / 'library-refresh.log'
        if log.exists() and log.stat().st_size > 2 * 1024 * 1024:
            os.replace(log, state_dir / 'library-refresh.previous.log')
        commands = [([executable(config, 'bunBinary', 'bun'), str(Path(__file__).resolve().parents[2] / 'src/maintenance/library-sync.ts')], 3600),
                    ([executable(config, 'qmdBinary', 'qmd'), '--index', config.get('libraryIndex', 'source-search-library'), 'update'], 600),
                    ([executable(config, 'nodeBinary', 'node'), str(Path(__file__).resolve().parent / 'embeddings/run.mjs')], 900)]
        with log.open('a') as output:
            for args, timeout in commands:
                if stopping.is_set(): return
                save(state_dir / 'library-status.json', {'state':'refreshing','step':Path(args[0]).name + ' ' + args[-1], 'checkedAt':stamp()})
                child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True, env={**os.environ,"SOURCE_SEARCH_CONFIG_FILE":str(config_path)})
                timed_out = False
                try:
                    code = child.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    os.killpg(child.pid, signal.SIGTERM)
                    try: child.wait(timeout=10)
                    except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); child.wait()
                    code = child.returncode
                finally:
                    child = None
                if code:
                    raise RuntimeError('Library maintenance failed (exit ' + str(code) + '); see private log')
        save(state_dir / 'library-status.json', {'state':'idle','checkedAt':stamp()})

    worker = Refresher(config_path, state_dir, refresh)
    next_library = 0
    while not stopping.is_set():
        worker.step(time.monotonic())
        try:
            config = json.loads(Path(config_path).read_text())
            if config.get('libraryEnabled') and time.monotonic() >= next_library and not stopping.is_set():
                library_refresh(config)
                next_library = time.monotonic() + 60
        except Exception as error:
            save(state_dir / 'library-status.json', {'state':'error','error':str(error)[:500],'checkedAt':stamp()})
            next_library = time.monotonic() + 60
        stopping.wait(30)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--state-dir', required=True)
    arguments = parser.parse_args()
    run(arguments.config, arguments.state_dir)
