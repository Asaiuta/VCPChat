'use strict';
// Local SDK only: no Gradle, downloads, installation, ADB or global settings.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
function fail(message) { throw new Error(message); }
function value(flag) { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; }
if (args.includes('--help')) {
    console.log('node scripts/android-m4-fixture/build.cjs --sdk SDK_ROOT [--build-tools 36.0.0] [--platform android-35] [--jdk JDK_ROOT] [--variant a5]');
    process.exit(0);
}
for (let index = 0; index < args.length; index += 2) {
    if (!['--sdk', '--build-tools', '--platform', '--jdk', '--variant'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) fail('Unknown or incomplete build option');
}
// v1 (default) stays byte-reproducible for the frozen F1-F3 records; a5 adds PermissionActivity in its own output dir.
const variant = value('--variant') || 'v1';
if (!['v1', 'a5'].includes(variant)) fail('Unknown variant');
const sdkArg = value('--sdk') || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
if (!sdkArg) fail('Supply --sdk with an installed SDK; no packages are downloaded');
const sdk = path.resolve(sdkArg);
const version = value('--build-tools') || '36.0.0';
const platform = value('--platform') || 'android-35';
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^android-\d+(?:\.\d+)?$/.test(platform)) fail('Invalid SDK package name');
const tools = path.join(sdk, 'build-tools', version);
const suffix = process.platform === 'win32' ? '.exe' : '';
const exe = name => path.join(tools, name + suffix);
const javaHome = value('--jdk') || (fs.existsSync(path.join(sdk, 'jbr', 'bin', 'java' + suffix)) ? path.join(sdk, 'jbr') : process.env.JAVA_HOME);
if (!javaHome) fail('An installed JDK is required');
const jdk = name => path.join(javaHome, 'bin', name + suffix);
const androidJar = path.join(sdk, 'platforms', platform, 'android.jar');
for (const file of [androidJar, exe('aapt2'), exe('zipalign'), path.join(tools, 'lib', 'd8.jar'), path.join(tools, 'lib', 'apksigner.jar'), ...['java', 'javac', 'jar', 'keytool'].map(jdk)]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail('Missing local dependency: ' + file);
}
const out = path.resolve(__dirname, variant === 'a5' ? '.build-a5' : '.build');
const manifest = path.join(__dirname, variant === 'a5' ? 'AndroidManifest.a5.xml' : 'AndroidManifest.xml');
const classes = path.join(out, 'classes');
const gen = path.join(out, 'gen');
const dex = path.join(out, 'dex');
for (const dir of [out, classes, gen, dex]) fs.mkdirSync(dir, { recursive: true });
function run(file, argv) {
    const result = cp.spawnSync(file, argv, { cwd: __dirname, stdio: 'inherit', timeout: 120000, windowsHide: true });
    if (result.error || result.status !== 0) fail(path.basename(file) + ' failed: ' + (result.error?.code || result.status));
}
const resource = path.join(out, 'resources.apk');
const aligned = path.join(out, 'aligned.apk');
const compiled = path.join(out, 'resources.zip');
const apk = path.join(out, 'm4-fixture.apk');
run(exe('aapt2'), ['compile', '--dir', path.join(__dirname, 'res'), '-o', compiled]);
run(exe('aapt2'), ['link', '-I', androidJar, '--manifest', manifest, '--java', gen, '-o', resource, compiled]);
const sources = ['MainActivity.java', 'SingleTaskActivity.java', 'FixtureState.java', 'StateProvider.java', ...(variant === 'a5' ? ['PermissionActivity.java'] : [])]
    .map(name => path.join(__dirname, 'src/com/vcpchat/m4fixture', name));
run(jdk('javac'), ['--release', '8', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', classes, ...sources, path.join(gen, 'com/vcpchat/m4fixture/R.java')]);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
run(jdk('java'), ['-cp', path.join(tools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--lib', androidJar, '--min-api', '29', '--output', dex, ...walk(classes).filter(name => name.endsWith('.class'))]);
run(jdk('jar'), ['uf', resource, '-C', dex, 'classes.dex']);
run(exe('zipalign'), ['-f', '4', resource, aligned]);
const keystore = path.join(path.resolve(__dirname, '.build'), 'fixture-only.p12');
// Public disposable fixture signing material; never a production credential.
if (!fs.existsSync(keystore)) run(jdk('keytool'), ['-genkeypair', '-noprompt', '-keystore', keystore, '-storetype', 'PKCS12', '-storepass', 'fixture-only', '-keypass', 'fixture-only', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=M4 Disposable Display Fixture']);
run(jdk('java'), ['-jar', path.join(tools, 'lib', 'apksigner.jar'), 'sign', '--ks', keystore, '--ks-key-alias', 'fixture', '--ks-pass', 'pass:fixture-only', '--key-pass', 'pass:fixture-only', '--out', apk, aligned]);
run(jdk('java'), ['-jar', path.join(tools, 'lib', 'apksigner.jar'), 'verify', '--verbose', apk]);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidence = {
    phase: 'build', built: true, variant, apk, sha256: hash(apk), package: 'com.vcpchat.m4fixture',
    sdk, buildTools: version, platform, jdk: javaHome, deviceAcceptance: 'NOT_RUN',
    sources: [manifest, path.join(__dirname, 'res/values/ids.xml'), __filename, ...sources]
        .map(file => ({ path: path.relative(__dirname, file).replaceAll('\\', '/'), sha256: hash(file) })),
};
fs.writeFileSync(path.join(out, 'build-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
