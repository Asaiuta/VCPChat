"""JSONL lifecycle owner; one trial per process, bounded commands, no retries."""
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import sysconfig

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_native import AdapterError, WorldSession, LabSession, materialize, world_type, WORLD

LIMIT = 8 * 1024 * 1024


def error_code(error):
    return str(error) if isinstance(error, AdapterError) and re.fullmatch('[A-Z][A-Z0-9_]{0,79}', str(error)) else 'NATIVE_ADAPTER_FAILED'


def runtime_identity(suite):
    # A dedicated venv is required; user-site/PYTHONPATH are disabled by -I.
    roots = {Path(sys.prefix).resolve(), Path(sysconfig.get_path('stdlib')).resolve()}
    files = {Path(sys.executable).resolve()}
    for root in roots:
        for current, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if d not in ('__pycache__', '.git')
                       and not (root != Path(sys.prefix).resolve() and d in ('site-packages', 'dist-packages'))]
            for name in names:
                if not name.endswith(('.pyc', '.pyo')):
                    files.add((Path(current) / name).resolve())
    base = Path(sys.base_prefix)
    for file in list(base.glob('*.dll')) + list(base.glob('python*')):
        if file.is_file():
            files.add(file.resolve())
    dlls = base / 'DLLs'
    if dlls.is_dir():
        files.update(p.resolve() for p in dlls.rglob('*') if p.is_file() and p.suffix != '.pyc')
    modules = ['android_env', 'absl', 'numpy', 'grpc'] if suite == 'androidworld' else ['lxml', 'xmltodict']
    missing = [m for m in modules if importlib.util.find_spec(m) is None]
    return {'format': 'j02-python-runtime-v1', 'suite': suite, 'pythonPath': str(Path(sys.executable).resolve()),
            'version': sys.version, 'platform': platform.system(), 'isolated': sys.prefix != sys.base_prefix,
            'missing': missing,
            'distributions': sorted([d.metadata['Name'], d.version] for d in importlib.metadata.distributions()),
            'files': [{'file': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(files)]}


def read_json(stream):
    value = stream.readline(LIMIT + 1)
    if not value:
        return None
    if len(value.encode('utf-8')) > LIMIT or not value.endswith('\n'):
        raise AdapterError('BRIDGE_INPUT_LIMIT')
    return json.loads(value)


class Protocol:
    def __init__(self):
        self.session = None
        self.phase = 'new'
        self.runtime = self.lock = None

    def dispatch(self, request):
        op = request['op']
        if op == 'initialize' and self.phase == 'new':
            self.phase = 'initializing'
            runtime, case = request['runtime'], request['case']
            sys.path.insert(0, runtime['checkout'])
            lock = json.loads(Path(runtime['runtimeIdentityFile']).read_text(encoding='utf-8'))
            if runtime_identity(runtime['suite']) != lock:
                raise AdapterError('PYTHON_RUNTIME_CHANGED')
            self.runtime, self.lock = runtime, lock
            serial = request['serial']
            if serial != 'emulator-' + str(runtime['consolePort']):
                raise AdapterError('EMULATOR_IDENTITY_MISMATCH')

            def adb_read(args):
                reply = subprocess.run([request['adb'], '-s', serial, *args], capture_output=True,
                                       text=True, encoding='utf-8', timeout=30, check=True)
                return reply.stdout.strip()

            if runtime['suite'] == 'androidworld':
                self.session = WorldSession(runtime, case, request['adb'])
            else:
                self.session = LabSession(runtime, case, adb_read)
            answer = self.session.initialize()
            self.phase = 'initialized'
            return answer
        if op == 'score' and self.phase == 'initialized':
            self.phase = 'scoring'
            if self.runtime and runtime_identity(self.runtime['suite']) != self.lock:
                raise AdapterError('PYTHON_RUNTIME_CHANGED')
            answer = self.session.score(request['evidence'])
            self.phase = 'scored'
            return answer
        if op == 'cleanup' and self.phase != 'closed':
            self.phase = 'closed'
            return self.session.cleanup() if self.session is not None else {'clean': True}
        raise AdapterError('BRIDGE_PHASE_INVALID')


def serve():
    protocol = Protocol()
    while True:
        request = read_json(sys.stdin)
        if request is None:
            # Parent death does not authorize another write (including teardown).
            # Journal remains in-flight; caller must recover the environment explicitly.
            return
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = protocol.dispatch(request)
            response = {'id': request['id'], 'ok': True, 'result': result}
        except Exception as error:
            response = {'id': request.get('id'), 'ok': False, 'code': error_code(error)}
        print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)
        if request.get('op') == 'cleanup':
            return


def main():
    if sys.argv[1] == 'serve':
        serve()
        return
    request = read_json(sys.stdin)
    with contextlib.redirect_stdout(sys.stderr):
        if sys.argv[1] == 'runtime':
            value = runtime_identity(request['suite'])
        elif sys.argv[1] == 'materialize':
            sys.path.insert(0, request['checkout'])
            value = materialize(request['suite'], request['taskId'], request['seed'], request.get('goal'))
        else:
            raise AdapterError('BRIDGE_COMMAND_INVALID')
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == '__main__':
    # Python on Windows otherwise uses a locale encoding on pipes.
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    try:
        main()
    except Exception as error:
        print(error_code(error), file=sys.stderr)
        sys.exit(1)
