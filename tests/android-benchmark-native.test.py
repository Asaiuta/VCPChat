"""Offline native adapter checks. Upstream scorer tests require explicit checkout."""
import dataclasses
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from xml.etree.ElementTree import Element, SubElement, tostring

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts/android-j02'))
import benchmark_native as N
from benchmark_bridge import Protocol


def xml_screen(texts, package='com.mapswithme.maps.pro'):
    root = Element('hierarchy', {'rotation': '0'})
    def node(parent, text, cls, bounds, index):
        attrs = {'index': str(index), 'text': text, 'resource-id': '', 'class': cls, 'package': package,
                 'content-desc': '', 'checkable': 'false', 'checked': 'false', 'clickable': 'true',
                 'enabled': 'true', 'focusable': 'false', 'focused': 'false', 'scrollable': 'false',
                 'long-clickable': 'false', 'password': 'false', 'selected': 'false', 'bounds': bounds}
        return SubElement(parent, 'node', attrs)
    parent = node(root, '', 'android.widget.FrameLayout', '[0,0][1080,2400]', 0)
    for i, text in enumerate(texts):
        node(parent, text, 'android.widget.TextView', f'[20,{100+i*100}][1000,{180+i*100}]', i)
    return tostring(root, encoding='unicode')


class CodecTests(unittest.TestCase):
    def test_calendar_rows_roundtrip_and_no_arbitrary_type_import(self):
        cls = dataclasses.make_dataclass('CalendarEvent', [('start_ts', int), ('title', str)])
        cls.__module__ = N.CALENDAR.rsplit('.', 1)[0]
        module = types.ModuleType(cls.__module__)
        module.CalendarEvent = cls
        with patch.dict(sys.modules, {cls.__module__: module}):
            value = {'row_objects': [cls(10, 'Meeting')], 'noise_row_objects': [cls(20, 'Other')]}
            encoded = json.loads(json.dumps(N.encode(value)))
            self.assertEqual(N.decode(encoded), value)
            with self.assertRaises(N.AdapterError):
                N.decode({'$type': 'os.system', 'fields': {'command': 'never'}})
            encoded['row_objects'][0]['fields']['extra'] = 1
            with self.assertRaises(N.AdapterError):
                N.decode(encoded)
        for value in [float('nan'), {'$type': 'fake'}, {2: 'key'}, (1, 2)]:
            with self.assertRaises(N.AdapterError):
                N.encode(value)

    def test_materialization_freezes_full_params_goal_and_seed(self):
        class Task:
            @classmethod
            def generate_random_params(cls):
                return {'text': str(N.random.random()), 'noise': ['preserved']}
            def __init__(self, params):
                self.goal = 'Create ' + params['text']
        with patch.object(N, 'world_type', return_value=Task):
            one = N.materialize('androidworld', 'MarkorCreateNote', 42)
            self.assertEqual(one, N.materialize('androidworld', 'MarkorCreateNote', 42))
            self.assertEqual(one['params']['noise'], ['preserved'])
            self.assertEqual(one['params']['seed'], 42)


class LifecycleTests(unittest.TestCase):
    def session(self, failure=None):
        calls = []
        class Env:
            def reset(self, **kwargs):
                calls.append(('reset', kwargs))
            def close(self):
                calls.append(('close',))
        env = Env()
        class Task:
            def __init__(self, params):
                self.goal = 'Frozen goal'
                self.params = params
            def initialize_task(self, e):
                self.before = object()
                calls.append(('initialize', id(self), e))
                if failure == 'initialize':
                    raise RuntimeError('partial mutation')
            def is_successful(self, e):
                assert self.before is not None
                calls.append(('score', id(self), e))
                if failure == 'score':
                    raise RuntimeError('score failure')
                return 1.0
            def tear_down(self, e):
                calls.append(('teardown', id(self), e))
                if failure == 'cleanup':
                    raise RuntimeError('cleanup failure')
        session = N.WorldSession({'consolePort': 5554, 'grpcPort': 8554},
                                 {'seed': 3, 'taskId': 'MarkorCreateNote', 'params': {'seed': 3}, 'goal': 'Frozen goal'},
                                 'no-adb', factory=lambda **kw: env, task_factory=Task)
        return session, calls

    def test_same_instance_scores_before_teardown_and_closes(self):
        session, calls = self.session()
        self.assertEqual(session.initialize(), {'goal': 'Frozen goal'})
        self.assertEqual(session.score({})['score'], 1)
        self.assertEqual(session.cleanup(), {'clean': True})
        self.assertEqual([c[0] for c in calls], ['reset', 'initialize', 'score', 'teardown', 'close'])
        self.assertEqual(len({c[1] for c in calls if c[0] in ('initialize', 'score', 'teardown')}), 1)

    def test_partial_initialization_and_score_failures_still_close(self):
        for mode in ['initialize', 'score', 'cleanup']:
            with self.subTest(mode=mode):
                session, calls = self.session(mode)
                if mode == 'initialize':
                    with self.assertRaises(RuntimeError):
                        session.initialize()
                else:
                    session.initialize()
                    if mode == 'score':
                        with self.assertRaises(RuntimeError):
                            session.score({})
                if mode == 'cleanup':
                    with self.assertRaises(N.AdapterError):
                        session.cleanup()
                else:
                    session.cleanup()
                self.assertEqual(calls[-1][0], 'close')

    def test_protocol_rejects_repeated_score_and_cleanup(self):
        protocol = Protocol()
        protocol.session, _ = self.session()
        protocol.session.initialize()
        protocol.phase = 'initialized'
        protocol.dispatch({'op': 'score', 'evidence': {}})
        with self.assertRaises(N.AdapterError):
            protocol.dispatch({'op': 'score', 'evidence': {}})
        protocol.dispatch({'op': 'cleanup'})
        with self.assertRaises(N.AdapterError):
            protocol.dispatch({'op': 'cleanup'})

    def test_connection_failure_is_not_claimed_clean(self):
        session, _ = self.session()
        session.factory = lambda **kwargs: (_ for _ in ()).throw(RuntimeError('connection partially established'))
        with self.assertRaises(RuntimeError):
            session.initialize()
        with self.assertRaises(N.AdapterError):
            session.cleanup()


LAB = os.environ.get('J02_ANDROIDLAB_CHECKOUT')


@unittest.skipUnless(LAB, 'set J02_ANDROIDLAB_CHECKOUT to the pinned upstream checkout')
class UpstreamScorers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, LAB)

    def setUp(self):
        self.network = patch('socket.socket', side_effect=AssertionError('network forbidden'))
        self.process = patch('subprocess.run', side_effect=AssertionError('subprocess forbidden'))
        self.network.start()
        self.process.start()
        self.addCleanup(self.network.stop)
        self.addCleanup(self.process.stop)

    def test_original_map_judge_and_original_compressor(self):
        judge = N.lab_judge(LAB, 'map_12')
        for texts, expected in [(['Stanford', 'My location', 'Start'], True), (['Stanford', 'Start'], False), (['Other'], False)]:
            tree = N.compressed_tree(xml_screen(texts))
            self.assertEqual(judge.judge(tree, {}).get('complete', False), expected)
        self.assertNotIn('evaluation.definition', sys.modules)
        self.assertNotIn('utils_mobile.utils', sys.modules)

    def test_bluetooth_original_score_and_unknown_read_guard(self):
        judge = N.lab_judge(LAB, 'setting_3')
        for value, complete in [('0', True), ('1', False), ('', True), ('null', True)]:
            self.assertEqual(judge.judge({}, {'command': {'adb shell settings get global bluetooth_on': value}})['complete'], complete)
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'final.xml'
            file.write_text(xml_screen(['Bluetooth'], 'com.android.settings'), encoding='utf-8')
            for value, verdict in [('0', 'pass'), ('1', 'fail'), ('null', 'unknown')]:
                session = N.LabSession({'checkout': LAB}, {'taskId': 'setting_3'}, lambda args: value)
                result = session.score({'xmlFile': str(file)})
                self.assertEqual(result['verdict'], verdict)
                if verdict == 'unknown':
                    self.assertTrue(result['details']['complete'])
                    self.assertIsNone(result['score'])

    def test_dark_theme_checked_unchecked_and_wrong_page(self):
        judge = N.lab_judge(LAB, 'setting_7')
        for state, expected in [('checked', True), ('unchecked', False)]:
            tree = {'root': {'panel': {'Display TextView': {}, 'RecyclerView': {
                f'Dark theme Switch {state}': {}}}}}
            self.assertEqual(judge.judge(tree, {}).get('complete', False), expected)
        self.assertFalse(judge.judge({'root': {'Wrong': {}}}, {}).get('complete', False))

    def test_alarm_requires_time_label_and_enabled_in_same_alarm(self):
        judge = N.lab_judge(LAB, 'clock_1')
        def tree(time, label, status):
            return {'root': {'panel': {'Alarm TextView': {}, f'{time} TextView': {},
                                      f'{label} Label': {}, f'Switch {status}': {}}}}
        for time, label, status, expected in [('3:00\u200aPM', 'meeting', 'checked', True),
                                             ('3:00\u200aPM', 'other', 'checked', False),
                                             ('4:00\u200aPM', 'meeting', 'checked', False),
                                             ('3:00\u200aPM', 'meeting', 'unchecked', False)]:
            self.assertEqual(judge.judge(tree(time, label, status), {})['complete'], expected)

    def test_snapshot_failure_never_retries_and_does_not_score(self):
        calls = []
        def read(args):
            calls.append(args)
            return 'KO: snapshot not found'
        session = N.LabSession({'checkout': LAB, 'snapshotName': 'frozen'}, {'taskId': 'map_12', 'goal': 'x'}, read)
        with self.assertRaises(N.AdapterError):
            session.initialize()
        self.assertEqual(len(calls), 1)

    def test_blocked_tasks_and_xml_entities_fail_closed(self):
        for id in ['contacts_2', 'map_1', 'map_13']:
            with self.assertRaises(N.AdapterError):
                N.lab_judge(LAB, id)
        with self.assertRaises(N.AdapterError):
            N.compressed_tree('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///never">]><x>&x;</x>')


if __name__ == '__main__':
    unittest.main()
