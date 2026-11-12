"""Bounded upstream adapters. No agent, model client or scoring entrypoint imports."""
import ast
import dataclasses
import importlib
import json
import math
import random
from pathlib import Path

WORLD = {
    'SystemWifiTurnOn': 'system', 'SystemBluetoothTurnOff': 'system',
    'ContactsNewContactDraft': 'contacts', 'ContactsAddContact': 'contacts',
    'MarkorCreateNote': 'markor', 'SimpleCalendarAddOneEvent': 'calendar.calendar',
    'OsmAndMarker': 'osmand',
}
LAB = {
    'setting_3': ('setting/setting.py', ['SingleTask_Setting_3']),
    'setting_7': ('setting/setting.py', ['SingleTask_Setting_7']),
    'clock_1': ('clock/clock.py', ['extract_alarms', 'SingleTask_Clock_General', 'SingleTask_Clock_1']),
    'map_12': ('map_me/map.py', ['SingleTask_Mapme_12']),
}
BLOCKED = {'contacts_2': 'UPSTREAM_GOAL_ORACLE_CONFLICT', 'map_1': 'ANSWER_AND_JUDGE_CHANNEL_REQUIRED'}
CALENDAR = 'android_world.task_evals.utils.sqlite_schema_utils.CalendarEvent'


class AdapterError(Exception):
    pass


def support(suite, task_id):
    if task_id not in (WORLD if suite == 'androidworld' else LAB):
        raise AdapterError(BLOCKED.get(task_id, 'TASK_OUTSIDE_ADAPTER_SCOPE'))


def world_type(task_id):
    support('androidworld', task_id)
    return getattr(importlib.import_module('android_world.task_evals.single.' + WORLD[task_id]), task_id)


def encode(value):
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        name = type(value).__module__ + '.' + type(value).__name__
        if name != CALENDAR:
            raise AdapterError('PARAMETER_TYPE_UNSUPPORTED')
        return {'$type': name, 'fields': {f.name: encode(getattr(value, f.name)) for f in dataclasses.fields(value)}}
    if isinstance(value, dict):
        if '$type' in value or any(not isinstance(k, str) for k in value):
            raise AdapterError('PARAMETER_TYPE_UNSUPPORTED')
        return {k: encode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [encode(v) for v in value]
    if value is None or type(value) in (str, int, bool) or type(value) is float and math.isfinite(value):
        return value
    raise AdapterError('PARAMETER_TYPE_UNSUPPORTED')


def decode(value):
    if isinstance(value, dict):
        if '$type' in value:
            if set(value) != {'$type', 'fields'} or value['$type'] != CALENDAR:
                raise AdapterError('PARAMETER_TYPE_UNSUPPORTED')
            cls = getattr(importlib.import_module(CALENDAR.rsplit('.', 1)[0]), 'CalendarEvent')
            if set(value['fields']) != {f.name for f in dataclasses.fields(cls)}:
                raise AdapterError('PARAMETER_FIELDS_CHANGED')
            return cls(**{k: decode(v) for k, v in value['fields'].items()})
        return {k: decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [decode(v) for v in value]
    return value


def seed_random(seed):
    random.seed(seed)
    # The selected native generators also use numpy. Never regenerate params in a trial.
    if importlib.util.find_spec('numpy') is not None:
        importlib.import_module('numpy').random.seed(seed)


def materialize(suite, task_id, seed, goal=None):
    support(suite, task_id)
    seed_random(seed)
    if suite == 'androidworld':
        cls = world_type(task_id)
        params = cls.generate_random_params()
        params['seed'] = seed
        task = cls(params)
        return {'goal': task.goal, 'params': encode(params), 'seed': seed}
    return {'goal': goal, 'params': {}, 'seed': seed}


def _nodes(file, names):
    tree = ast.parse(Path(file).read_text(encoding='utf-8'))
    selected = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in names]
    if {n.name for n in selected} != set(names):
        raise AdapterError('UPSTREAM_SYMBOL_CHANGED')
    return selected


def lab_judge(root, task_id):
    """Execute exact selected AST definitions, excluding imports and model methods."""
    support('androidlab', task_id)
    root = Path(root)
    base = _nodes(root / 'evaluation/task.py', ['SingleTask'])[0]
    base.body = [n for n in base.body if isinstance(n, ast.FunctionDef) and n.name in ('__init__', 'judge_page')]
    nodes = [base] + _nodes(root / 'evaluation/utils.py', ['find_subtrees_of_parents_with_key'])
    file, names = LAB[task_id]
    nodes += _nodes(root / 'evaluation/tasks' / file, names)
    tree = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
    forbidden = {'check_answer', 'detect_answer', 'open', 'exec', 'eval', '__import__'}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)) or isinstance(node, ast.Name) and node.id in forbidden \
                or isinstance(node, ast.Attribute) and node.attr in forbidden:
            raise AdapterError('UPSTREAM_SCORER_DEPENDENCY_CHANGED')
    namespace = {'__name__': 'isolated_upstream_judge'}
    exec(compile(tree, str(root / 'evaluation/tasks' / file), 'exec'), namespace)
    return namespace[names[-1]](None)


def compressed_tree(xml):
    # Same compressor and level as utils_mobile.utils.get_compressed_xml, without
    # importing that module's model / screenshot dependencies.
    if '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper():
        raise AdapterError('XML_DECLARATION_UNSUPPORTED')
    cls = importlib.import_module('utils_mobile.xml_tool').UIXMLTree
    return json.loads(cls().process(xml, level=1, str_type='json').strip())


class WorldSession:
    def __init__(self, runtime, case, adb, factory=None, task_factory=None):
        self.runtime, self.case, self.adb = runtime, case, adb
        self.env = self.task = None
        self.factory, self.task_factory = factory, task_factory
        self.snapshot_errors = []
        self.restore = self.snapshot_module = None
        self.connection_attempted = False

    def initialize(self):
        seed_random(self.case['seed'])
        cls = self.task_factory or world_type(self.case['taskId'])
        self.task = cls(decode(self.case['params']))
        if self.task.goal != self.case['goal']:
            raise AdapterError('NATIVE_GOAL_CHANGED')
        if self.factory is None:
            # Capture errors even when TaskEval._initialize_apps suppresses them.
            from android_world.task_evals import task_eval
            self.snapshot_module = task_eval.app_snapshot
            self.restore = self.snapshot_module.restore_snapshot

            def strict_restore(*args, **kwargs):
                try:
                    return self.restore(*args, **kwargs)
                except Exception:
                    self.snapshot_errors.append(True)
                    raise
            self.snapshot_module.restore_snapshot = strict_restore
            launcher = importlib.import_module('android_world.env.env_launcher')
            # Retain env ownership even if setup_env raises after connecting.
            self.connection_attempted = True
            self.env = launcher._get_env(self.runtime['consolePort'], self.adb, self.runtime['grpcPort'])
            launcher.setup_env(self.env, emulator_setup=False, freeze_datetime=True)
        else:
            self.connection_attempted = True
            self.env = self.factory(console_port=self.runtime['consolePort'], grpc_port=self.runtime['grpcPort'],
                                    adb_path=self.adb, emulator_setup=False, freeze_datetime=True)
        self.env.reset(go_home=True)
        self.task.initialize_task(self.env)
        if self.snapshot_errors:
            raise AdapterError('NATIVE_SETUP_UNPROVEN')
        return {'goal': self.task.goal}

    def score(self, _evidence):
        score = float(self.task.is_successful(self.env))
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise AdapterError('NATIVE_SCORE_INVALID')
        return {'score': score, 'verdict': 'pass' if score == 1 else 'fail', 'details': {}}

    def cleanup(self):
        errors = [True] if self.connection_attempted and self.env is None else []
        try:
            if self.env is not None and self.task is not None:
                before = len(self.snapshot_errors)
                try:
                    self.task.tear_down(self.env)
                    if len(self.snapshot_errors) != before:
                        errors.append(True)
                except Exception:
                    errors.append(True)
        finally:
            if self.env is not None:
                try:
                    self.env.close()
                except Exception:
                    errors.append(True)
            if self.snapshot_module is not None:
                self.snapshot_module.restore_snapshot = self.restore
        if errors:
            raise AdapterError('NATIVE_CLEANUP_UNPROVEN')
        return {'clean': True}


class LabSession:
    def __init__(self, runtime, case, adb_read):
        self.runtime, self.case, self.read = runtime, case, adb_read
        self.judge = lab_judge(runtime['checkout'], case['taskId'])

    def restore(self):
        value = self.read(['emu', 'avd', 'snapshot', 'load', self.runtime['snapshotName']])
        if 'OK' not in value.splitlines() or 'KO' in value or 'error' in value.lower():
            raise AdapterError('SNAPSHOT_RESTORE_UNPROVEN')
        self.read(['wait-for-device'])
        if self.read(['shell', 'getprop', 'sys.boot_completed']).strip() != '1':
            raise AdapterError('SNAPSHOT_DEVICE_NOT_READY')

    def initialize(self):
        self.restore()
        return {'goal': self.case['goal']}

    def score(self, evidence):
        line = {}
        if self.case['taskId'] == 'setting_3':
            value = self.read(['shell', 'settings', 'get', 'global', 'bluetooth_on']).strip()
            # Original judge treats any value other than "1" as success. Preserve
            # its output but do not admit malformed/missing device evidence.
            line['command'] = {'adb shell settings get global bluetooth_on': value}
        tree = compressed_tree(Path(evidence['xmlFile']).read_text(encoding='utf-8'))
        details = self.judge.judge(tree, line)
        if self.case['taskId'] == 'setting_3' and value not in ('0', '1'):
            return {'score': None, 'verdict': 'unknown', 'details': details, 'code': 'NATIVE_COMMAND_UNPROVEN'}
        if not isinstance(details, dict) or not isinstance(details.get('judge_page'), bool):
            raise AdapterError('NATIVE_SCORE_INVALID')
        complete = details.get('complete', False)
        if not isinstance(complete, bool):
            raise AdapterError('NATIVE_SCORE_INVALID')
        return {'score': int(complete), 'verdict': 'pass' if complete else 'fail', 'details': details}

    def cleanup(self):
        self.restore()
        return {'clean': True}
