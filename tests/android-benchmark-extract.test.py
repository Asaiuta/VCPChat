"""Offline parser checks. No upstream modules, devices or model clients loaded."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("benchmark_extract", Path(__file__).parents[1] / "scripts/android-j02/benchmark-extract.py")
EXTRACT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXTRACT)


class BenchmarkExtractionTest(unittest.TestCase):
    def test_proto_braces_comments_escaped_quotes_and_parameter_names(self):
        text = '''# tasks { fake }
tasks {
 name: "RealTask"
 prompt: "Find {title} with \\"quotes\\""
 task_params { name: "not_a_task" possible_values: "}" }
 relevant_state { state { calendar { app_name: "calendar" } } }
}
'''
        task = list(EXTRACT.proto_tasks(text))[0]
        self.assertEqual(task["name"], "RealTask")
        self.assertEqual(task["prompt"], 'Find {title} with "quotes"')
        self.assertEqual(task["appNames"], ["calendar"])
        self.assertEqual(task["line"], 2)

    def test_proto_rejects_truncation_duplicate_fields_and_unknown_syntax(self):
        for text in ['tasks { name: "x" prompt: "y"',
                     'tasks { name: "x" name: "z" prompt: "y" }',
                     'tasks { name: "x" prompt: "y" } !']:
            with self.subTest(text=text), self.assertRaises(EXTRACT.Unsupported):
                list(EXTRACT.proto_tasks(text))

    def source(self, files):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for file, value in files.items():
            target = root / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(value, encoding="utf-8")
        return EXTRACT.Source(root)

    def test_ast_never_executes_top_level_code_and_resolves_diamond_inheritance(self):
        source = self.source({"pkg/models.py": '''
raise RuntimeError("must never execute")
class Root:
    template = "root"
class Left(Root):
    pass
class Right(Root):
    template = "right"
class Child(Left, Right):
    pass
''', "pkg/derived.py": '''
from pkg.models import Child as Base
class Task(Base):
    schema = {"type": "object"}
'''.lstrip()})
        source.load("pkg")
        self.assertEqual(source.literal(source.member("pkg.derived.Task", "template")), "right")
        self.assertEqual(source.mro("pkg.models.Child"), ["pkg.models.Child", "pkg.models.Left", "pkg.models.Right", "pkg.models.Root"])

    def test_computed_properties_are_not_fabricated_as_literal_data(self):
        source = self.source({"pkg/task.py": '''
class Task:
    @property
    def app_names(self):
        return self.params["app"]
'''.lstrip()})
        source.load("pkg")
        self.assertIsNone(source.literal(source.member("pkg.task.Task", "app_names")))
        self.assertEqual(source.ref(source.member("pkg.task.Task", "app_names"))["symbol"], "app_names")

    def test_sources_cannot_escape_checkout(self):
        source = self.source({"pkg/one.py": "pass"})
        with self.assertRaises(EXTRACT.Unsupported):
            source.read("../outside.py")

    def lab(self, config):
        return self.source({
            "evaluation/task.py": "raise RuntimeError('no upstream import')\nclass SingleTask: pass\n",
            "evaluation/tasks/setting/__init__.py": "from .setting import *\nfunction_map = {'setting_1': TestTask}\n",
            "evaluation/tasks/setting/setting.py": "from evaluation.task import *\nclass TestTask(SingleTask):\n    def judge(self, tree, line): return self.check_answer(line)\n",
            "evaluation/config/setting.yaml": config,
            "generate_result.py": "if __name__ == '__main__':\n    detect_answer_test(args)\n"
        })

    def test_lab_keeps_commands_as_data_and_marks_judge_and_startup_probe(self):
        source = self.lab('''APP: Settings
package: com.android.settings
tasks:
  - task_id: setting_1
    task: Read a setting
    metric_func: evaluation.tasks.setting
    metric_type: query_detect
    adb_query: adb shell echo never_execute
''')
        tasks, details = EXTRACT.lab(source)
        self.assertEqual(tasks[0]["judgeModel"], "required")
        self.assertEqual(tasks[0]["upstream"]["adb_query"], "adb shell echo never_execute")
        self.assertTrue(details["scoringEntrypointHasSyntheticProbe"])
        self.assertEqual(tasks[0]["hooks"]["judge"]["symbol"], "evaluation.tasks.setting.setting.TestTask")

    def test_lab_rejects_duplicate_keys_aliases_and_python_tags(self):
        import yaml
        for config in ['APP: first\nAPP: overwritten\n', 'APP: &x [*x]\n', '!!python/object/apply:os.system [echo bad]']:
            with self.subTest(config=config), self.assertRaises((EXTRACT.Unsupported, yaml.YAMLError)):
                EXTRACT.lab(self.lab(config))


if __name__ == "__main__":
    unittest.main()
