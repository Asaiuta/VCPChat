"""Read upstream benchmark definitions as data; never import their modules.

Python's AST handles AndroidWorld inheritance without loading AndroidEnv or a
provider. AndroidLab YAML is read with a safe loader; ADB command strings remain
data. This is inventory/preparation, not an implementation of upstream scoring.
"""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys


class Unsupported(ValueError):
    pass


def assignments(nodes):
    for node in nodes:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    yield target.id, node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            yield node.target.id, node.value


class Source:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.modules = {}
        self.classes = {}
        self.used = set()

    def read(self, relative):
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root) or path.stat().st_size > 8 * 1024 * 1024:
            raise Unsupported("source path or size")
        self.used.add(path.relative_to(self.root).as_posix())
        return path.read_text(encoding="utf-8-sig")

    def load(self, prefix):
        for file in sorted((self.root / prefix).rglob("*.py")):
            if file.name.endswith("_test.py"):
                continue
            relative = file.relative_to(self.root).as_posix()
            module = relative[:-3].replace("/", ".")
            if module.endswith(".__init__"):
                module = module[:-9]
            tree = ast.parse(self.read(relative), filename=relative)
            aliases, stars = {}, []
            for node in tree.body:
                if isinstance(node, ast.ImportFrom):
                    parent = module if file.name == "__init__.py" else module.rsplit(".", 1)[0]
                    base = node.module or ""
                    if node.level:
                        parts = parent.split(".")
                        base = ".".join(parts[:len(parts) - node.level + 1] + ([base] if base else []))
                    for alias in node.names:
                        if alias.name == "*":
                            stars.append(base)
                        else:
                            aliases[alias.asname or alias.name] = base + "." + alias.name
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        aliases[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
                elif isinstance(node, ast.ClassDef):
                    self.classes[module + "." + node.name] = (module, node)
            self.modules[module] = {"file": relative, "tree": tree, "aliases": aliases, "stars": stars}

    def resolve(self, expr, module):
        name = ast.unparse(expr)
        first, _, tail = name.partition(".")
        aliases = self.modules[module]["aliases"]
        candidates = [aliases[first] + ("." + tail if tail else "")] if first in aliases else []
        candidates += [module + "." + name, name]
        candidates += [base + "." + name for base in self.modules[module]["stars"]]
        for candidate in candidates:
            if candidate in self.classes:
                return candidate
        return None

    def mro(self, key, visiting=()):
        if key in visiting:
            raise Unsupported("cyclic class hierarchy")
        module, node = self.classes[key]
        bases = [resolved for base in node.bases if (resolved := self.resolve(base, module))]
        sequences = [self.mro(base, visiting + (key,)) for base in bases] + [bases[:]]
        result = [key]
        while any(sequences):
            sequences = [seq for seq in sequences if seq]
            head = next((seq[0] for seq in sequences if not any(seq[0] in other[1:] for other in sequences)), None)
            if head is None:
                raise Unsupported("inconsistent class hierarchy")
            result.append(head)
            sequences = [seq[1:] if seq[0] == head else seq for seq in sequences]
        return result

    def member(self, key, name):
        for owner in self.mro(key):
            module, node = self.classes[owner]
            for attr, value in assignments(node.body):
                if attr == name:
                    return module, value
            for value in node.body:
                if isinstance(value, (ast.FunctionDef, ast.AsyncFunctionDef)) and value.name == name:
                    return module, value
        return None

    def literal(self, pair, seen=()):
        if pair is None:
            return None
        module, value = pair
        try:
            return ast.literal_eval(value)
        except (ValueError, TypeError):
            if isinstance(value, ast.Attribute):
                owner = self.resolve(value.value, module)
                identity = (owner, value.attr)
                if owner and identity not in seen:
                    return self.literal(self.member(owner, value.attr), seen + (identity,))
        return None

    def ref(self, pair):
        if not pair:
            return None
        module, node = pair
        return {"file": self.modules[module]["file"], "line": node.lineno,
                "symbol": getattr(node, "name", None)}


def proto_tasks(text):
    """Split top-level tasks while respecting comments and quoted braces.

    Only inventory fields are decoded. The complete original block is hashed;
    parameter generation and success criteria are left to the native harness.
    """
    pattern = re.compile(r'\s+|\#[^\n]*|//[^\n]*|"(?:\\.|[^"\\])*"|[A-Za-z_][\w.]*|[-+]?\d+(?:\.\d+)?|[{}<>:\[\],;]')
    tokens, position = [], 0
    for match in pattern.finditer(text):
        if match.start() != position:
            raise Unsupported("unsupported textproto syntax")
        position = match.end()
        value = match.group()
        if not value.isspace() and not value.startswith(("#", "//")):
            tokens.append((value, match.start(), match.end()))
    if position != len(text):
        raise Unsupported("trailing textproto syntax")
    index = 0
    while index < len(tokens):
        if tokens[index][0] != "tasks" or tokens[index + 1][0] != "{":
            raise Unsupported("unsupported top-level proto field")
        start, depth, fields, apps = index, 0, {}, []
        index += 1
        while index < len(tokens):
            token = tokens[index][0]
            if token in ("{", "<"):
                depth += 1
            elif token in ("}", ">"):
                depth -= 1
                if depth == 0:
                    break
            if token in ("name", "prompt", "app_name") and index + 2 < len(tokens) and tokens[index + 1][0] == ":":
                raw = tokens[index + 2][0]
                if raw.startswith('"'):
                    value = ast.literal_eval(raw)
                    if depth == 1 and token in ("name", "prompt"):
                        if token in fields:
                            raise Unsupported("duplicate task proto field")
                        fields[token] = value
                    elif token == "app_name":
                        apps.append(value)
            index += 1
        if depth != 0 or set(fields) != {"name", "prompt"}:
            raise Unsupported("incomplete task proto")
        raw = text[tokens[start][1]:tokens[index][2]]
        yield {**fields, "appNames": sorted(set(apps)), "line": text[:tokens[start][1]].count("\n") + 1,
               "blockSha256": hashlib.sha256(raw.encode()).hexdigest()}
        index += 1


def world(source):
    source.load("android_world")
    registry = source.classes["android_world.registry.TaskRegistry"]
    registered = dict(assignments(registry[1].body))["_TASKS"]
    if not isinstance(registered, (ast.Tuple, ast.List)):
        raise Unsupported("task registry changed")
    tasks = []
    adb = source.modules["android_world.env.adb_utils"]
    activities = dict(assignments(adb["tree"].body))["_PATTERN_TO_ACTIVITY"]
    if not isinstance(activities, ast.Call) or len(activities.args) != 1:
        raise Unsupported("activity mapping changed")
    mapping = ast.literal_eval(activities.args[0])
    def packages(apps):
        found = []
        for app in apps:
            matches = {activity.split("/")[0] for aliases, activity in mapping.items() if app in aliases.split("|")}
            if len(matches) != 1:
                return None
            found.extend(matches)
        return sorted(set(found)) if apps else None
    for value in registered.elts:
        key = source.resolve(value, registry[0])
        if key is None:
            raise Unsupported("unresolved registered class")
        module, node = source.classes[key]
        goal = source.member(key, "goal")
        # An overridden goal property takes precedence over a literal template.
        dynamic = goal and goal[0] != "android_world.task_evals.task_eval"
        template = None if dynamic else source.literal(source.member(key, "template"))
        apps = source.literal(source.member(key, "app_names"))
        if not isinstance(apps, (list, tuple)) or not all(isinstance(app, str) for app in apps):
            apps = []
        tasks.append({"id": node.name, "appNames": list(apps), "packages": packages(apps),
                      "goalTemplate": template if isinstance(template, str) and template else None,
                      "parameterSchema": source.literal(source.member(key, "schema")),
                      "definition": {"file": source.modules[module]["file"], "line": node.lineno, "symbol": key},
                      "hooks": {name: source.ref(source.member(key, name)) for name in
                                ("goal", "generate_random_params", "initialize_task", "is_successful", "tear_down")},
                      "answerRequired": False, "judgeModel": "not_invoked_by_importer"})
    proto_file = "android_world/task_evals/information_retrieval/proto/tasks.textproto"
    for entry in proto_tasks(source.read(proto_file)):
        tasks.append({"id": entry["name"], "appNames": entry["appNames"], "packages": packages(entry["appNames"]),
                      "goalTemplate": entry["prompt"], "parameterSchema": None,
                      "definition": {"file": proto_file, "line": entry["line"], "symbol": entry["name"], "blockSha256": entry["blockSha256"]},
                      "hooks": {"nativeClass": "android_world.task_evals.information_retrieval.information_retrieval.InformationRetrieval"},
                      "answerRequired": True, "judgeModel": "not_invoked_by_importer"})
    return tasks, {"scope": "android_world registry including information_retrieval; excludes MiniWoB and disabled phone tasks"}


def lab(source):
    import yaml
    class UniqueLoader(yaml.SafeLoader):
        pass
    def mapping(loader, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in result:
                raise Unsupported("duplicate YAML key")
            result[key] = loader.construct_object(value_node, deep=deep)
        return result
    UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    source.load("evaluation")
    tasks = []
    for file in sorted((source.root / "evaluation/config").glob("*.yaml")):
        relative = file.relative_to(source.root).as_posix()
        raw = source.read(relative)
        if any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(raw)):
            raise Unsupported("YAML aliases are unsupported")
        config = yaml.load(raw, Loader=UniqueLoader)
        for task in config["tasks"]:
            module = task["metric_func"]
            mapping_node = dict(assignments(source.modules[module]["tree"].body))["function_map"]
            if not isinstance(mapping_node, ast.Dict):
                raise Unsupported("metric mapping changed")
            choices = {ast.literal_eval(k): v for k, v in zip(mapping_node.keys, mapping_node.values)}
            key = source.resolve(choices[task["task_id"]], module)
            if key is None:
                raise Unsupported("unresolved metric")
            metric_module, node = source.classes[key]
            # Conservative inventory of calls on this class and its inherited
            # methods. This is not a claim that arbitrary Python is network-free.
            local_methods = [value for _, class_node in (source.classes[k] for k in source.mro(key)) for value in class_node.body
                             if isinstance(value, ast.FunctionDef) and value.name == "judge"]
            judge_calls = {ast.unparse(n.func) for method in local_methods for n in ast.walk(method) if isinstance(n, ast.Call)}
            judge_model = "required" if "self.check_answer" in judge_calls else "not_detected_static_review_required"
            tasks.append({"id": task["task_id"], "appNames": [config["APP"]], "packages": [config["package"]],
                          "goalTemplate": task["task"], "parameterSchema": None,
                          "definition": {"file": relative, "symbol": task["task_id"]},
                          "hooks": {"judge": {"file": source.modules[metric_module]["file"], "line": node.lineno, "symbol": key}},
                          "answerRequired": judge_model == "required", "judgeModel": judge_model,
                          "upstream": task})
    scorer = source.read("generate_result.py")
    probe_call = any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "detect_answer_test"
                     for n in ast.walk(ast.parse(scorer)))
    return tasks, {"pyyaml": yaml.__version__, "scoringEntrypointHasSyntheticProbe": probe_call,
                   "probeLocation": "generate_result.py", "scope": "all evaluation/config/*.yaml task entries"}


def host():
    roots = [os.environ.get(name) for name in ("ANDROID_SDK_ROOT", "ANDROID_HOME")]
    if os.environ.get("JAVA_HOME"):
        roots.append(str(Path(os.environ["JAVA_HOME"]).parent))
    if os.environ.get("LOCALAPPDATA"):
        roots.append(str(Path(os.environ["LOCALAPPDATA"]) / "Android/Sdk"))
    sdks = []
    for root in sorted(set(r for r in roots if r)):
        images = Path(root) / "system-images"
        if images.is_dir():
            sdks.append({"root": str(Path(root).resolve()), "imagePackages": sorted(str(p.relative_to(images)).replace("\\", "/") for p in images.rglob("package.xml"))})
    return {"platform": sys.platform, "python": sys.version.split()[0], "sdk": sdks,
            "dockerAvailableOnPath": shutil.which("docker") is not None,
            "androidEnvInstalled": importlib.util.find_spec("android_env") is not None,
            "deviceInspected": False, "imagesBooted": False}


def extract(suite, root):
    source = Source(root)
    tasks, details = {"androidworld": world, "androidlab": lab}[suite](source)
    ids = [task["id"] for task in tasks]
    if not ids or len(ids) != len(set(ids)):
        raise Unsupported("empty or duplicate tasks")
    for task in tasks:
        task["clusterId"] = suite + ":" + task["id"]
        task["calibrated"] = False
    return {"tasks": tasks, "details": details, "readFiles": sorted(source.used), "host": host()}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in ("androidworld", "androidlab"):
            raise Unsupported("arguments")
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(extract(sys.argv[1], sys.argv[2]), ensure_ascii=True, allow_nan=False))
    except Exception as error:
        print("J02_BENCHMARK_EXTRACT_FAILED: " + type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
