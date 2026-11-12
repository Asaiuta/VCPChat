'use strict';
// Offline SDK/JDK only. Never downloads dependencies or contacts a device.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2);
const value = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
for (let i = 0; i < args.length; i += 2) {
    if (!['--sdk', '--build-tools', '--platform', '--jdk'].includes(args[i]) || !args[i + 1]) throw Error('Invalid build option');
}
const sdkArg = value('--sdk') || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
if (!sdkArg) throw Error('Supply --sdk pointing at an installed Android SDK');
const sdk = path.resolve(sdkArg);
const version = value('--build-tools') || '36.0.0';
const platform = value('--platform') || 'android-35';
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^android-\d+(?:\.\d+)?$/.test(platform)) throw Error('Invalid SDK version');
const javaHome = value('--jdk') || (fs.existsSync(path.join(sdk, 'jbr')) ? path.join(sdk, 'jbr') : process.env.JAVA_HOME);
if (!javaHome) throw Error('Installed JDK required');
const jdk = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const androidJar = path.join(sdk, 'platforms', platform, 'android.jar');
const d8 = path.join(sdk, 'build-tools', version, 'lib/d8.jar');
for (const file of [androidJar, d8, ...['java', 'javac', 'jar'].map(jdk)]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw Error('Missing local dependency: ' + file);
}
const out = path.join(__dirname, '.build');
const classes = path.join(out, 'classes'), dex = path.join(out, 'dex');
for (const dir of [out, classes, dex]) fs.mkdirSync(dir, { recursive: true });
function run(file, argv) {
    const r = cp.spawnSync(file, argv, { stdio: 'inherit', windowsHide: true, timeout: 120000 });
    if (r.error || r.status !== 0) throw Error(path.basename(file) + ' failed: ' + (r.error?.code || r.status));
}
run(jdk('javac'), ['--release', '8', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', classes,
    path.join(__dirname, 'src/com/vcpchat/uiautomator/Owner.java')]);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
run(jdk('java'), ['-cp', d8, 'com.android.tools.r8.D8', '--lib', androidJar, '--min-api', '23', '--output', dex,
    ...walk(classes).filter(file => file.endsWith('.class'))]);
const jar = path.resolve(__dirname, '../../VCPDistributedServer/Plugin/AndroidController/vendor/vcp-ui-owner.jar');
run(jdk('jar'), ['--create', '--file', jar, '--date=2020-01-01T00:00:00Z', '-C', dex, 'classes.dex']);
console.log(JSON.stringify({ built: true, jar, sha256: createHash('sha256').update(fs.readFileSync(jar)).digest('hex'), deviceAcceptance: 'NOT_RUN' }));
