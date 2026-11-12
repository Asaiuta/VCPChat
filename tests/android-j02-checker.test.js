'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkBook, reportValidator, sourceIdentity } = require('../scripts/android-j02-search.cjs');
const Ajv = require('ajv');
const schema = require('../docs/android-controller/j02/report.schema.json');
const pkg = 'io.legado.app.release';
const node = (id, text = '', children = '', extra = '') => `<node package="${pkg}" resource-id="${pkg}:id/${id}" text="${text}" visible-to-user="true" password="false" bounds="[0,0][800,800]" ${extra}>${children}</node>`;
const row = (title, author) => node('row', '', node('tv_name', title) + node('tv_author', author));
const xml = (rows, query = '魔女之旅') => `<?xml version="1.0"?><hierarchy>${node('root', '', node('search_src_text', query) + node('recycler_view', '', rows))}</hierarchy>`;

test('both exploration schemas match the current policy before any real task can start', () => {
    const { SEARCH_POLICY, UI_TASK_POLICY } = require('../modules/services/androidTaskPolicy');
    const uiSchema = require('../docs/android-controller/j02/ui-report.schema.json');
    assert.equal(typeof reportValidator(schema, `jev-candidate-${SEARCH_POLICY.version}`), 'function');
    assert.equal(typeof reportValidator(uiSchema, `jev-candidate-${UI_TASK_POLICY.version}`), 'function');
    assert.throws(() => reportValidator(uiSchema, 'jev-candidate-ui-task-stale'), { code: 'REPORT_POLICY_MISMATCH' });
});

test('source freeze covers the loaded controller dependencies outside its package directory', t => {
    const fs = require('node:fs'), path = require('node:path');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'j02-identity-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const jar = path.join(dir, 'snapshot.jar'); fs.writeFileSync(jar, 'offline test artifact');
    require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
    const identity = sourceIdentity(jar), root = path.resolve(__dirname, '..');
    for (const file of Object.keys(require.cache)) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        if (/^(?:modules\/|VCPDistributedServer\/Plugin\/AndroidController\/|scripts\/)/.test(relative))
            assert.match(identity[relative] || '', /^[0-9a-f]{64}$/, relative);
    }
    assert.ok(identity['modules/utils/atomicReplace.js']);
});

test('independent checker requires exact title and author in the same unique result row', () => {
    assert.equal(checkBook(xml(row('魔女之旅', '白石定规'))).verdict, 'pass');
    assert.equal(checkBook(xml(row('魔女之旅', '作者：白石定规'))).verdict, 'pass');
    assert.equal(checkBook(xml(row('魔女之旅', '另一作者') + row('另一本', '白石定规'))).verdict, 'fail');
    assert.equal(checkBook(xml(row('魔女之旅外传', '白石定规'))).verdict, 'fail');
    assert.equal(checkBook(xml(row('魔女之旅', '白石定规'), '旧查询')).verdict, 'fail');
    assert.equal(checkBook(xml('')).verdict, 'fail');
});
test('ambiguous grouping, hidden author and foreign package cannot establish business success', () => {
    assert.equal(checkBook(xml(node('wrapper', '', row('魔女之旅', '另一作者') + row('另一本', '白石定规')))).verdict, 'fail');
    assert.equal(checkBook(xml(row('魔女之旅', '白石定规')).replace('text="白石定规" visible-to-user="true"', 'text="白石定规" visible-to-user="false"')).verdict, 'fail');
    assert.equal(checkBook(xml(row('魔女之旅', '白石定规')).replace(`package="${pkg}" resource-id="${pkg}:id/tv_author"`, `package="other.app" resource-id="${pkg}:id/tv_author"`)).verdict, 'fail');
});
test('unreadable or ambiguous independent observation is never a pass', () => {
    assert.throws(() => checkBook(''), { code: 'CHECKER_XML_INVALID' });
    assert.throws(() => checkBook('<?xml version="1.0"?><!DOCTYPE hierarchy><hierarchy/>'), { code: 'CHECKER_XML_INVALID' });
    const ambiguous = xml(row('魔女之旅', '白石定规')).replace('</hierarchy>', node('recycler_view') + '</hierarchy>');
    assert.equal(checkBook(ambiguous).verdict, 'unknown');
});
test('exploration schema rejects admission flags and incomplete evidence', () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    assert.equal(validate({ schemaVersion: 1, stage: 'exploration', calibrated: true }), false);
    assert.ok(validate.errors.some(e => e.dataPath === '.calibrated'));
    assert.ok(Math.abs((1 - Math.pow(0.05, 1 / 30)) - 0.095) < 0.0001);
    assert.equal(1 - Math.pow(0.05, 1 / 148) >= 0.02, true);
    assert.equal(1 - Math.pow(0.05, 1 / 149) < 0.02, true);
    assert.equal(1 - Math.pow(0.05 / 3, 1 / 203) < 0.02, true);
});
