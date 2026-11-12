'use strict';
// Local SDK only; writes a validation artifact, never installs or runs on a device.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const [sdk, output] = process.argv.slice(2);
if (!sdk || !output || process.argv.length !== 4) throw Error('Usage: node build.cjs SDK_ROOT NEW_OUTPUT_DIRECTORY');
const jar = path.join(sdk, 'platforms/android-35/android.jar');
const d8 = path.join(sdk, 'build-tools/36.0.0/lib/d8.jar');
const jdk = name => path.join(sdk, 'jbr/bin', name + (process.platform === 'win32' ? '.exe' : ''));
const out = path.resolve(output), classes = path.join(out, 'classes'), dex = path.join(out, 'dex');
fs.mkdirSync(out); fs.mkdirSync(classes); fs.mkdirSync(dex);
function run(file, args) {
    const r = cp.spawnSync(file, args, { stdio: 'inherit', windowsHide: true, timeout: 60000 });
    if (r.error || r.status !== 0) throw Error('BUILD_FAILED');
}
const source = path.join(__dirname, 'src/com/vcpchat/validation/Snapshot.java');
run(jdk('javac'), ['--release', '8', '-encoding', 'UTF-8', '-classpath', jar, '-d', classes, source]);
run(jdk('java'), ['-cp', d8, 'com.android.tools.r8.D8', '--lib', jar, '--min-api', '23', '--output', dex,
    path.join(classes, 'com/vcpchat/validation/Snapshot.class')]);
const artifact = path.join(out, 'independent-snapshot.jar');
run(jdk('jar'), ['--create', '--file', artifact, '--date=2020-01-01T00:00:00Z', '-C', dex, 'classes.dex']);
const hashes = Object.fromEntries([source, jar, d8, artifact].map(file => [path.resolve(file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ hashes, runtimeInputs: 'none', deviceStatus: 'NOT_RUN' }, null, 2));
console.log(JSON.stringify({ artifact, sha256: hashes[artifact] }));
