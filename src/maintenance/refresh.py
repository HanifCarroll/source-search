#!/usr/bin/python3
"""Refresh selected source snapshots and optional search indexes; never edit originals."""
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


def vault_roots(config):
    roots = {}
    for source in config.get('enabledSources', []):
        setting = config.get('sources', {}).get(source, {})
        if setting.get('adapter', source) == 'vault':
            roots.update({source + '/' + name: path for name, path in setting.get('roots', config.get('qmdRoots', {})).items()})
    return roots


def snapshot(config):
    roots = vault_roots(config)
    if not roots:
        raise RuntimeError('No QMD collection roots configured')
    digest = hashlib.sha256(json.dumps({'sdk':2,'roots':roots,'models':config.get('searchModels',config.get('qmdModels'))}, sort_keys=True).encode())
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
    for root in vault_roots(config).values():
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
            if not config.get('maintenanceEnabled') or not vault_roots(config):
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


def embedding_enabled(config):
    """Models are optional; keyword indexing never needs an embedding pass."""
    models = config.get('searchModels')
    if models:
        return all(models.get(kind) for kind in ('embed', 'rerank', 'generate'))
    return len(config.get('qmdModels', [])) == 3


def index_commands(config, library=False):
    # The separate source worker owns provider synchronization.
    args = ['index', '--library', '--skip-source-sync'] if library else ['index']
    commands = [(args, 3600 if library else 600)]
    if embedding_enabled(config):
        commands.append((['index', *(['--library'] if library else []), '--embed-only'], 1800))
    return commands


class CommandRunner:
    """One worker's child process, with shared logging and cancellation behavior."""
    def __init__(self, config_path, state_dir, stopping):
        self.config_path, self.state_dir = str(config_path), Path(state_dir)
        self.stopping, self.child = stopping, None
        self.guard = threading.Lock()

    def stop(self):
        with self.guard:
            if self.child and self.child.poll() is None:
                try:
                    os.killpg(self.child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def run(self, config, commands, log_name):
        binary = executable(config, 'bunBinary', 'bun')
        cli = str(Path(__file__).resolve().parents[2] / 'src/cli.ts')
        log = self.state_dir / (log_name + '.log')
        if log.exists() and log.stat().st_size > 2 * 1024 * 1024:
            os.replace(log, self.state_dir / (log_name + '.previous.log'))
        with log.open('a') as output:
            for args, timeout in commands:
                with self.guard:
                    if self.stopping.is_set():
                        raise RuntimeError('Refresh interrupted; will resume after restart')
                    output.write('\n' + stamp() + ' ' + ' '.join(args) + '\n'); output.flush()
                    child = subprocess.Popen([binary, cli, *args], stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                             start_new_session=True, env={**os.environ, 'SOURCE_SEARCH_CONFIG_FILE': self.config_path})
                    self.child = child
                try:
                    # Short waits make shutdown responsive even if a child ignores SIGTERM.
                    deadline = time.monotonic() + timeout
                    while child.poll() is None and not self.stopping.is_set() and time.monotonic() < deadline:
                        self.stopping.wait(0.25)
                    if self.stopping.is_set():
                        raise RuntimeError('Refresh interrupted; will resume after restart')
                    if child.poll() is None:
                        raise RuntimeError('Maintenance timed out; see private ' + log.name)
                    if child.returncode:
                        raise RuntimeError('Maintenance failed (exit ' + str(child.returncode) + '); see private ' + log.name)
                finally:
                    if child.poll() is None:
                        self.stop()
                        try:
                            child.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            os.killpg(child.pid, signal.SIGKILL); child.wait()
                    with self.guard:
                        self.child = None


def periodic_refresh(config_path, state_dir, name, enabled, refresh):
    """Record each independent stage's outcome, retaining retryable failures."""
    path = Path(state_dir) / (name + '-status.json')
    try:
        config = json.loads(Path(config_path).read_text())
        if not config.get('maintenanceEnabled') or not enabled(config):
            save(path, {'state': 'disabled', 'checkedAt': stamp()})
            return
        save(path, {'state': 'refreshing', 'checkedAt': stamp()})
        refresh(config)
        save(path, {'state': 'idle', 'checkedAt': stamp()})
    except Exception as error:
        save(path, {'state': 'error', 'error': str(error)[:500], 'checkedAt': stamp()})


def run(config_path, state_dir):
    state_dir = Path(state_dir)
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (state_dir / 'watcher.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return
    stopping = threading.Event()
    indexes = CommandRunner(config_path, state_dir, stopping)
    sources = CommandRunner(config_path, state_dir, stopping)

    def stop(_signum, _frame):
        # Workers observe this event and terminate their own process groups.
        # Do not acquire a worker lock inside a signal handler.
        stopping.set()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def refresh(config):
        materialize(config)
        indexes.run(config, index_commands(config), 'refresh')

    def sync_loop():
        while not stopping.is_set():
            periodic_refresh(config_path, state_dir, 'sources', lambda c: bool(c.get('enabledSources')),
                             lambda c: sources.run(c, [(['sync-sources'], 3600)], 'sources-refresh'))
            stopping.wait(60)

    # Snapshot sources stay current even while embeddings load or an index fails.
    source_worker = threading.Thread(target=sync_loop, name='source-sync')
    source_worker.start()
    worker = Refresher(config_path, state_dir, refresh)
    next_library = 0
    try:
        while not stopping.is_set():
            worker.step(time.monotonic())
            if time.monotonic() >= next_library and not stopping.is_set():
                periodic_refresh(config_path, state_dir, 'library',
                                 lambda c: c.get('libraryEnabled') and 'library' in c.get('enabledSources', []),
                                 lambda c: indexes.run(c, index_commands(c, library=True), 'library-refresh'))
                next_library = time.monotonic() + 60
            stopping.wait(30)
    finally:
        stopping.set()
        sources.stop(); indexes.stop()
        source_worker.join()
        lock.close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--state-dir', required=True)
    arguments = parser.parse_args()
    run(arguments.config, arguments.state_dir)
