'use strict';

/**
 * 基线判定与存储层的行为契约测试。
 * 重点只有一个：任何“数据不全”的情形都不许判成 pass。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildFingerprint,
  loadBaseline,
  saveBaseline,
  compare,
  readPath,
  formatCheck,
} = require('../VCPDistributedServer/Plugin/AndroidController/lib/perf-baseline');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-baseline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const OBSERVE_RULES = [
  { name: 'observe.p95Ms', path: 'cases.observe.p95Ms', op: 'lteFactor', factor: 0.8 },
];

test('反假绿：没有基线数据时 verdict 是 no_baseline，绝不能是 pass', () => {
  const sample = { cases: { observe: { p95Ms: 900 } } };

  // 这条用例是整套判定的红线：基线缺失时必须明确表达“无法判定”，
  // 而不是拿模块内置的默认阈值把 900 判成通过。
  const result = compare(sample, null, OBSERVE_RULES);
  assert.equal(result.verdict, 'no_baseline');
  assert.notEqual(result.verdict, 'pass');
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].status, 'missing');
  assert.notEqual(result.checks[0].status, 'pass');

  const undef = compare(sample, undefined, OBSERVE_RULES);
  assert.equal(undef.verdict, 'no_baseline');
  assert.notEqual(undef.verdict, 'pass');
  assert.ok(undef.checks.every((check) => check.status === 'missing'));
});

test('loadBaseline：不存在 -> absent，损坏 JSON -> corrupt，都不抛异常', (t) => {
  const dir = makeTempDir(t);
  const key = 'host.local-platform.linux';

  assert.doesNotThrow(() => {
    const absent = loadBaseline(dir, key);
    assert.equal(absent.ok, false);
    assert.equal(absent.reason, 'absent');
  });

  // 目录本身不存在也应当收敛成 absent，而不是 ENOENT 冒泡。
  const missingDir = path.join(dir, 'not-created');
  const absentAgain = loadBaseline(missingDir, key);
  assert.equal(absentAgain.ok, false);
  assert.equal(absentAgain.reason, 'absent');

  fs.writeFileSync(path.join(dir, `${key}.json`), '{oops', 'utf8');
  assert.doesNotThrow(() => {
    const corrupt = loadBaseline(dir, key);
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.reason, 'corrupt');
  });
});

test('saveBaseline -> loadBaseline 往返深等值', (t) => {
  const dir = makeTempDir(t);
  const key = buildFingerprint({ hostTag: 'ci', platform: 'win32', serialTag: 'dev1' }).key;
  const payload = {
    schema: 1,
    device: { model: 'mi13', android: 13 },
    cases: { observe: { p95Ms: 812.5, samples: 60 } },
    tags: ['perf', 'observe'],
  };

  const saved = saveBaseline(dir, key, payload);
  assert.equal(saved.ok, true);
  assert.equal(saved.path, path.join(dir, `${key}.json`));

  const loaded = loadBaseline(dir, key);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.baseline, payload);
});

test('lteFactor 全通过 -> pass；越界 -> fail 且 limit 精确等于 base*factor', () => {
  const baseline = { cases: { observe: { p95Ms: 1000 }, scroll: { p95Ms: 500 } } };
  const rules = [
    { name: 'observe.p95Ms', path: 'cases.observe.p95Ms', op: 'lteFactor', factor: 0.9 },
    { name: 'scroll.p95Ms', path: 'cases.scroll.p95Ms', op: 'lteFactor', factor: 0.9 },
  ];

  const green = compare({ cases: { observe: { p95Ms: 900 }, scroll: { p95Ms: 450 } } }, baseline, rules);
  assert.equal(green.verdict, 'pass');
  assert.deepEqual(green.checks.map((check) => check.status), ['pass', 'pass']);

  const red = compare({ cases: { observe: { p95Ms: 901 }, scroll: { p95Ms: 450 } } }, baseline, rules);
  assert.equal(red.verdict, 'fail');
  const failing = red.checks[0];
  assert.equal(failing.status, 'fail');
  assert.equal(failing.actual, 901);
  assert.equal(failing.limit, 1000 * 0.9);
  assert.equal(red.checks[1].status, 'pass');
});

test('缺指标不得通过：样本缺路径或基线缺路径都判 incomplete', () => {
  const baseline = { cases: { observe: { p95Ms: 1000 } } };
  const rules = [
    { name: 'observe.p95Ms', path: 'cases.observe.p95Ms', op: 'lteFactor', factor: 0.9 },
    { name: 'observe.jankPct', path: 'cases.observe.jankPct', op: 'lteFactor', factor: 0.9 },
  ];

  const sampleMissing = compare({ cases: { observe: { p95Ms: 100 } } }, baseline, rules);
  assert.equal(sampleMissing.verdict, 'incomplete');
  assert.deepEqual(sampleMissing.checks.map((check) => check.status), ['pass', 'missing']);

  const baselineMissing = compare(
    { cases: { observe: { p95Ms: 100, jankPct: 0 } } },
    { cases: { observe: { p95Ms: 1000 } } },
    rules,
  );
  assert.equal(baselineMissing.verdict, 'incomplete');
  assert.equal(baselineMissing.checks[1].status, 'missing');

  // fail 的优先级高于 incomplete。
  const mixed = compare(
    { cases: { observe: { p95Ms: 99999 } } },
    baseline,
    rules,
  );
  assert.equal(mixed.verdict, 'fail');
});

test('非有限数（NaN / Infinity / 字符串 / null）一律按 missing 处理', () => {
  const baseline = { cases: { observe: { p95Ms: 1000 } } };
  const bogusValues = [Number.NaN, Number.POSITIVE_INFINITY, '123', null];

  for (const bogus of bogusValues) {
    const sample = { cases: { observe: { p95Ms: bogus } } };
    const result = compare(sample, baseline, OBSERVE_RULES);
    assert.equal(result.verdict, 'incomplete', `样本值 ${String(bogus)} 不应通过`);
    assert.equal(result.checks[0].status, 'missing');
    assert.notEqual(result.verdict, 'pass');

    const badBaseline = compare({ cases: { observe: { p95Ms: 1 } } }, { cases: { observe: { p95Ms: bogus } } }, OBSERVE_RULES);
    assert.equal(badBaseline.verdict, 'incomplete', `基线值 ${String(bogus)} 不应通过`);
    assert.notEqual(badBaseline.verdict, 'pass');
  }
});

test('四种 op 各一条正例与反例', () => {
  const baseline = { m: { a: 100 } };
  const at = (value) => ({ m: { a: value } });

  const cases = [
    { op: 'lteFactor', param: { factor: 1.2 }, limit: 100 * 1.2, passAt: 120, failAt: 120.5 },
    { op: 'gteFactor', param: { factor: 0.8 }, limit: 100 * 0.8, passAt: 80, failAt: 79.5 },
    { op: 'ltePlus', param: { delta: 25 }, limit: 100 + 25, passAt: 125, failAt: 126 },
    { op: 'eq', param: {}, limit: 100, passAt: 100, failAt: 101 },
  ];

  for (const item of cases) {
    const rule = [{ name: `check.${item.op}`, path: 'm.a', op: item.op, ...item.param }];

    const positive = compare(at(item.passAt), baseline, rule);
    assert.equal(positive.verdict, 'pass', `${item.op} 正例应通过`);
    assert.equal(positive.checks[0].status, 'pass');
    assert.equal(positive.checks[0].limit, item.limit);

    const negative = compare(at(item.failAt), baseline, rule);
    assert.equal(negative.verdict, 'fail', `${item.op} 反例应失败`);
    assert.equal(negative.checks[0].status, 'fail');
    assert.equal(negative.checks[0].limit, item.limit);
  }
});

test('when 谓词返回 false -> not_applicable，且不参与判定', () => {
  const baseline = { m: { a: 100, jank: 0.02 } };
  const sample = { m: { a: 90, jank: 0.5 } };
  const rules = [
    { name: 'a', path: 'm.a', op: 'lteFactor', factor: 0.95 },
    {
      name: 'jank',
      path: 'm.jank',
      op: 'lteFactor',
      factor: 1,
      when: (input) => input.m.a > 500,
    },
  ];

  const mixed = compare(sample, baseline, rules);
  assert.equal(mixed.verdict, 'pass');
  assert.deepEqual(mixed.checks.map((check) => check.status), ['pass', 'not_applicable']);

  // 只剩 not_applicable 的规则集仍然算 pass（没有任何一条可判定项失败或缺失）。
  const onlySkipped = compare(sample, baseline, [rules[1]]);
  assert.equal(onlySkipped.verdict, 'pass');
  assert.equal(onlySkipped.checks[0].status, 'not_applicable');
});

test('buildFingerprint：确定性、字符集、长度、序列号隔离、缺字段不留字面量', () => {
  const input = {
    hostTag: 'DESKTOP-ABC',
    platform: 'win32',
    arch: 'x64',
    nodeVersion: 'v24.22.2',
    adbVersion: '1.0.41',
    manufacturer: 'Xiaomi',
    model: 'MI 13',
    androidRelease: '13',
    sdk: 33,
    serialTag: 'dev1',
    serial: '192.168.1.5:5555',
  };

  const first = buildFingerprint(input);
  const second = buildFingerprint(input);
  assert.equal(first.key, second.key);
  assert.deepEqual(first.fields, second.fields);

  assert.match(first.key, /^[a-z0-9.-]+$/);
  assert.ok(first.key.length <= 120, 'key 长度必须 <= 120');
  assert.equal(first.key, first.key.toLowerCase());
  assert.ok(!first.key.includes('192.168.1.5'));
  assert.ok(!first.key.includes('5555'));
  assert.ok(first.key.includes('serial.dev1'));
  assert.equal(first.fields.serial, 'dev1');

  const empty = buildFingerprint({});
  assert.match(empty.key, /^[a-z0-9.-]+$/);
  assert.ok(!empty.key.includes('undefined'));
  assert.ok(!empty.key.includes('null'));
  assert.deepEqual(empty.fields, {});

  const partial = buildFingerprint({ hostTag: 'pi', nodeVersion: 'v20.0.0', model: null, sdk: undefined });
  assert.ok(!/undefined|null/.test(partial.key));
  assert.equal(partial.fields.model, undefined);
  assert.equal(partial.fields.sdk, undefined);

  const longKey = buildFingerprint({ hostTag: 'h'.repeat(400), platform: 'linux' }).key;
  assert.ok(longKey.length <= 120);
  assert.match(longKey, /^[a-z0-9.-]+$/);
});

test('readPath 边界：空路径、中间为 null、数组下标、深层不存在', () => {
  const tree = { a: { b: 1 }, list: [{ v: 10 }, { v: 20 }], nul: null, str: 'x' };

  assert.equal(readPath(tree, ''), undefined);
  assert.equal(readPath(tree, undefined), undefined);
  assert.equal(readPath(tree, 'nul.b'), undefined);
  assert.equal(readPath(tree, 'nul'), null);
  assert.equal(readPath(tree, 'list.0.v'), 10);
  assert.equal(readPath(tree, 'list.1.v'), 20);
  assert.equal(readPath(tree, 'list.0'), tree.list[0]);
  assert.equal(readPath(tree, 'a.b.c.d'), undefined);
  assert.equal(readPath(tree, 'str.length'), undefined);
  assert.equal(readPath(null, 'a'), undefined);
  assert.equal(readPath(undefined, 'a'), undefined);
  assert.equal(readPath(tree, 'toString'), undefined);
});

test('formatCheck 输出单行可读文本', () => {
  const baseline = { cases: { observe: { p95Ms: 900 } } };
  const pass = compare({ cases: { observe: { p95Ms: 700 } } }, baseline, OBSERVE_RULES);
  assert.equal(formatCheck(pass.checks[0]), '[pass] observe.p95Ms 700 <= 720?');

  const fail = compare({ cases: { observe: { p95Ms: 1200 } } }, baseline, OBSERVE_RULES);
  assert.equal(formatCheck(fail.checks[0]), '[fail] observe.p95Ms 1200 <= 720?');

  const missing = compare({ cases: {} }, baseline, OBSERVE_RULES);
  const line = formatCheck(missing.checks[0]);
  assert.ok(line.startsWith('[missing] observe.p95Ms '));
  assert.ok(!line.includes('\n'));

  const skipped = compare(
    { cases: { observe: { p95Ms: 900 } } },
    baseline,
    [{ ...OBSERVE_RULES[0], when: () => false }],
  );
  assert.ok(formatCheck(skipped.checks[0]).startsWith('[not_applicable] observe.p95Ms'));
});

test('compare 是纯函数：不修改入参', () => {
  const sample = { cases: { observe: { p95Ms: 900 } } };
  const baseline = { cases: { observe: { p95Ms: 1000 } } };
  const sampleCopy = structuredClone(sample);
  const baselineCopy = structuredClone(baseline);

  compare(sample, baseline, OBSERVE_RULES);
  assert.deepEqual(sample, sampleCopy);
  assert.deepEqual(baseline, baselineCopy);
});

test('空规则集不产生通过结论', () => {
  const result = compare({ any: 1 }, { any: 1 }, []);
  assert.notEqual(result.verdict, 'pass');
  assert.equal(result.verdict, 'incomplete');
  assert.deepEqual(result.checks, []);
});
