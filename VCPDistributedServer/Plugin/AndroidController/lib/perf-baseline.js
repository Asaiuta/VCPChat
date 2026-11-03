'use strict';

/**
 * Android 控制器性能基线的判定与存储层。
 *
 * 设计约束：
 * 1) 唯一数据来源是调用方传入的 artifact JSON（<dir>/<key>.json）；模块内不存在任何
 *    默认阈值或兜底数值 —— 用内置默认值判定，等于把回归藏进“通过”里。
 * 2) 无基线、样本缺指标、值非有限数，一律不可能判为 pass。
 * 3) compare / readPath / formatCheck 是纯函数，不碰文件系统；只有 loadBaseline /
 *    saveBaseline 访问磁盘，目录由调用方提供（测试传临时目录）。
 */

const fs = require('node:fs');
const nodePath = require('node:path');

const KEY_MAX_LENGTH = 120;
const KEY_PATTERN = /^[a-z0-9.-]{1,120}$/;
const EMPTY_KEY = 'unspecified';

// 参与指纹的字段及顺序固定；表外的键（例如真实 serial）一律忽略，避免序列号进 key。
// serialTag 紧跟 hostTag：key 超长被截断时，区分设备的那一段不能被截掉。
const FINGERPRINT_FIELDS = [
  ['host', 'hostTag'],
  ['serial', 'serialTag'],
  ['platform', 'platform'],
  ['arch', 'arch'],
  ['node', 'nodeVersion'],
  ['adb', 'adbVersion'],
  ['vendor', 'manufacturer'],
  ['model', 'model'],
  ['android', 'androidRelease'],
  ['sdk', 'sdk'],
];

const OP_SYMBOLS = {
  lteFactor: '<=',
  gteFactor: '>=',
  ltePlus: '<=',
  eq: '==',
};

const OP_HANDLERS = {
  // 实际值不得超过基线的 factor 倍（factor 通常 < 1，表示允许的更严上限）。
  lteFactor: {
    needsParam: true,
    paramOf: (rule) => rule.factor,
    limitOf: (expected, param) => expected * param,
    test: (actual, limit) => actual <= limit,
  },
  // 实际值不得低于基线的 factor 倍（用于吞吐、帧率这类越高越好的指标）。
  gteFactor: {
    needsParam: true,
    paramOf: (rule) => rule.factor,
    limitOf: (expected, param) => expected * param,
    test: (actual, limit) => actual >= limit,
  },
  // 绝对余量：基线 + delta。
  ltePlus: {
    needsParam: true,
    paramOf: (rule) => rule.delta,
    limitOf: (expected, param) => expected + param,
    test: (actual, limit) => actual <= limit,
  },
  // 精确相等，用于版本号、枚举状态这类离散指标。
  eq: {
    needsParam: false,
    paramOf: () => 0,
    limitOf: (expected) => expected,
    test: (actual, limit) => actual === limit,
  },
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 把单个字段值压成合法的 key 片段：小写、只留 [a-z0-9.]、去首尾点、折叠连续点。
 * 缺失值、空串，以及字面量 'undefined' / 'null' 都视为“无此字段”。
 */
function normalizeSegment(value) {
  if (value === null || value === undefined) return '';
  let text = (typeof value === 'string' ? value : String(value)).trim().toLowerCase();
  if (text === '' || text === 'undefined' || text === 'null') return '';
  // mDNS 无线序列号形如 `adb-beca2585-utuYDs._adb-tls-connect._tcp`。
  // 尾缀 `_adb-tls-connect._tcp` / `_adb-tls-pairing._tcp` 对每一台无线设备
  // 都相同，零区分度，却要吃掉 22 个字符 —— 实测会把 120 长度的 key 撑爆，
  // 截断恰好切掉 `adb.1.0.41`，于是「换了 adb 版本」这个第一线索从文件名消失。
  // 剥掉尾缀是无损的：设备标识（adb-<id>）完整保留。
  text = text.replace(/\._adb-tls-(?:connect|pairing)\._tcp\.?$/, '');
  if (text === '') return '';
  return text
    .replace(/[^a-z0-9.]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

// FNV-1a 32 位；用于超长 key 截断后保住区分度，输出恒为 8 位小写十六进制。
function hash32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function clampKey(joined) {
  if (!joined) return EMPTY_KEY;
  if (joined.length <= KEY_MAX_LENGTH) return joined;
  const suffix = `-h.${hash32(joined)}`;
  const head = joined.slice(0, KEY_MAX_LENGTH - suffix.length).replace(/[.-]+$/, '');
  return `${head}${suffix}`;
}

/**
 * 生成基线指纹。
 * 相同输入必出相同 key；只使用调用方给的 serialTag，绝不读取真实设备序列号。
 */
function buildFingerprint(input) {
  const source = input && typeof input === 'object' ? input : {};
  const fields = {};
  const segments = [];
  for (const [label, sourceKey] of FINGERPRINT_FIELDS) {
    const value = normalizeSegment(source[sourceKey]);
    if (!value) continue;
    fields[label] = value;
    segments.push(`${label}.${value}`);
  }
  return { key: clampKey(segments.join('-')), fields };
}

function assertSafeKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.startsWith('.') || key.includes('..')) {
    throw new TypeError(`非法基线指纹: ${String(key)}`);
  }
  return key;
}

function baselinePath(dir, key) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new TypeError('基线目录必须是非空字符串');
  }
  return nodePath.join(dir, `${assertSafeKey(key)}.json`);
}

/**
 * 同步读取基线。
 * 文件不存在 -> { ok:false, reason:'absent' }；存在但不可读/不可解析/不是对象 -> 'corrupt'。
 * 任何情况下都不抛异常（除入参本身非法）。
 */
function loadBaseline(dir, key) {
  const file = baselinePath(dir, key);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const reason = err && err.code === 'ENOENT' ? 'absent' : 'corrupt';
    return { ok: false, reason, path: file };
  }
  const text = raw.replace(/^\uFEFF/, '');
  let baseline;
  try {
    baseline = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: 'corrupt', path: file, detail: err.message };
  }
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return { ok: false, reason: 'corrupt', path: file, detail: '基线内容不是 JSON 对象' };
  }
  return { ok: true, baseline, path: file };
}

/** 同步写基线；写前确保目录存在。 */
function saveBaseline(dir, key, payload) {
  if (payload === undefined) throw new TypeError('基线 payload 不能是 undefined');
  const file = baselinePath(dir, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { ok: true, path: file };
}

/** 安全点路径读取：路径为空、中间为 null/undefined/标量、键不存在，都返回 undefined。 */
function readPath(obj, path) {
  if (typeof path !== 'string' || path === '') return undefined;
  const segments = path.split('.');
  let cursor = obj;
  for (let i = 0; i < segments.length; i += 1) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object' && typeof cursor !== 'function') return undefined;
    const segment = segments[i];
    if (segment === '' || !Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function checkName(rule) {
  if (typeof rule.name === 'string' && rule.name !== '') return rule.name;
  if (typeof rule.path === 'string' && rule.path !== '') return rule.path;
  return 'unnamed';
}

function describeValue(value) {
  if (value === undefined) return '缺失';
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `字符串"${value}"`;
  if (typeof value === 'boolean') return String(value);
  return typeof value;
}

function describeMissing(actual, expected) {
  const parts = [];
  if (!isFiniteNumber(actual)) parts.push(`样本值非有限数(${describeValue(actual)})`);
  if (!isFiniteNumber(expected)) parts.push(`基线值非有限数(${describeValue(expected)})`);
  return parts.join('，');
}

function evaluateRule(sample, baseline, rule) {
  const base = {
    name: checkName(rule),
    path: typeof rule.path === 'string' ? rule.path : undefined,
    op: rule.op,
  };

  if (typeof rule.when === 'function') {
    let applicable;
    try {
      applicable = Boolean(rule.when(sample));
    } catch (err) {
      return {
        ...base,
        status: 'missing',
        actual: undefined,
        limit: undefined,
        note: `when 谓词抛出异常: ${err && err.message ? err.message : String(err)}`,
      };
    }
    if (!applicable) {
      return { ...base, status: 'not_applicable', actual: undefined, limit: undefined, note: 'when 判定不适用' };
    }
  }

  const actual = readPath(sample, rule.path);
  const expected = readPath(baseline, rule.path);
  if (!isFiniteNumber(actual) || !isFiniteNumber(expected)) {
    return {
      ...base,
      status: 'missing',
      actual,
      limit: undefined,
      note: describeMissing(actual, expected),
    };
  }

  const handler = OP_HANDLERS[rule.op];
  if (!handler) {
    return {
      ...base,
      status: 'missing',
      actual,
      limit: undefined,
      note: `未知 op: ${String(rule.op)}`,
    };
  }
  const param = handler.needsParam ? handler.paramOf(rule) : 0;
  if (handler.needsParam && !isFiniteNumber(param)) {
    return {
      ...base,
      status: 'missing',
      actual,
      limit: undefined,
      note: `op ${rule.op} 的参数缺失或非有限数`,
    };
  }

  const limit = handler.limitOf(expected, param);
  const passed = handler.test(actual, limit);
  return {
    ...base,
    status: passed ? 'pass' : 'fail',
    actual,
    limit,
    note: '',
  };
}

/**
 * 对比样本与基线。
 * 判定优先级：no_baseline > fail > incomplete > pass。
 * 任何一项不可判定（missing）都会把整体压到 incomplete 或更差，不存在“缺指标默认通过”。
 */
function compare(sample, baseline, rules) {
  const ruleList = Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule === 'object') : [];

  if (baseline === null || baseline === undefined) {
    return {
      verdict: 'no_baseline',
      checks: ruleList.map((rule) => ({
        name: checkName(rule),
        path: typeof rule.path === 'string' ? rule.path : undefined,
        op: rule.op,
        status: 'missing',
        actual: undefined,
        limit: undefined,
        note: '无基线数据，无法判定',
      })),
    };
  }

  // 没有可校验的 check 就没有通过依据：空规则集不算 pass。
  if (ruleList.length === 0) {
    return { verdict: 'incomplete', checks: [] };
  }

  const checks = ruleList.map((rule) => evaluateRule(sample, baseline, rule));
  let verdict = 'pass';
  if (checks.some((check) => check.status === 'fail')) {
    verdict = 'fail';
  } else if (checks.some((check) => check.status === 'missing')) {
    verdict = 'incomplete';
  }
  return { verdict, checks };
}

/** 数字格式化：整数原样，其余保留至多 3 位小数，避免浮点尾巴污染 CLI 输出。 */
function formatNumber(value) {
  if (!isFiniteNumber(value)) return describeValue(value);
  return String(Math.round(value * 1000) / 1000);
}

/** 单行人类可读，用于 CLI 逐条输出。 */
function formatCheck(check) {
  if (!check || typeof check !== 'object') return '[missing] <invalid-check> - 非法 check';
  const name = check.name || check.path || 'unnamed';
  const status = check.status || 'missing';
  if (status === 'not_applicable') {
    return `[not_applicable] ${name} (跳过${check.note ? `: ${check.note}` : ''})`;
  }
  if (status === 'missing') {
    return `[missing] ${name} - ${check.note || '缺失或非有限数'}`;
  }
  const symbol = OP_SYMBOLS[check.op] || '?';
  const line = `[${status}] ${name} ${formatNumber(check.actual)} ${symbol} ${formatNumber(check.limit)}?`;
  return check.note ? `${line} ${check.note}` : line;
}

module.exports = {
  buildFingerprint,
  loadBaseline,
  saveBaseline,
  compare,
  readPath,
  formatCheck,
};
