'use strict';
// Local SDK only. No Gradle, downloads, installation, device commands or global configuration writes.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const args = process.argv.slice(2);
function fail(message) { throw new Error(message); }
function value(flag) { const n = args.indexOf(flag); return n < 0 ? null : args[n + 1]; }
if (args.includes('--help')) {
    console.log('node scripts/android-m15-fixture/build.cjs --sdk SDK_ROOT [--build-tools 36.0.0] [--platform android-35] [--jdk JDK_ROOT]');
    process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
    if (!['--sdk', '--build-tools', '--platform', '--jdk'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) fail('Unknown or incomplete build option');
}
const sdkArg = value('--sdk') || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
if (!sdkArg) fail('An existing SDK is required; supply --sdk. This builder never downloads SDK packages.');
const sdk = path.resolve(sdkArg);
const version = value('--build-tools') || '36.0.0';
const platform = value('--platform') || 'android-35';
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^android-\d+(?:\.\d+)?$/.test(platform)) fail('Invalid SDK package name');
const tools = path.join(sdk, 'build-tools', version);
const exe = name => path.join(tools, name + (process.platform === 'win32' ? '.exe' : ''));
const javaHome = value('--jdk') || (fs.existsSync(path.join(sdk, 'jbr', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')) ? path.join(sdk, 'jbr') : process.env.JAVA_HOME);
if (!javaHome) fail('An installed JDK is required');
const jdk = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const androidJar = path.join(sdk, 'platforms', platform, 'android.jar');
for (const file of [androidJar, exe('aapt2'), exe('zipalign'), path.join(tools, 'lib', 'd8.jar'), path.join(tools, 'lib', 'apksigner.jar'), ...['java', 'javac', 'jar', 'keytool'].map(jdk)]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail('Missing local build dependency: ' + file);
}
const out = path.resolve(__dirname, '.build');
const classes = path.join(out, 'classes'), gen = path.join(out, 'gen'), dex = path.join(out, 'dex');
for (const dir of [out, classes, gen, dex]) fs.mkdirSync(dir, { recursive: true });
function run(file, argv) {
    const r = cp.spawnSync(file, argv, { cwd: __dirname, stdio: 'inherit', timeout: 120000, windowsHide: true });
    if (r.error || r.status !== 0) fail(path.basename(file) + ' failed: ' + (r.error?.code || r.status));
}
const resource = path.join(out, 'resources.apk'), aligned = path.join(out, 'aligned.apk');
const compiled = path.join(out, 'resources.zip'), apk = path.join(out, 'm15-fixture.apk');
run(exe('aapt2'), ['compile', '--dir', path.join(__dirname, 'res'), '-o', compiled]);
run(exe('aapt2'), ['link', '-I', androidJar, '--manifest', path.join(__dirname, 'AndroidManifest.xml'), '--java', gen, '-o', resource, compiled]);
const sources = ['MainActivity.java', 'StateProvider.java', 'SearchFixture.java', 'JourneyFixture.java', 'PeerActivity.java'].map(n => path.join(__dirname, 'src/com/vcpchat/m15fixture', n));
run(jdk('javac'), ['--release', '8', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', classes, ...sources, path.join(gen, 'com/vcpchat/m15fixture/R.java')]);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
run(jdk('java'), ['-cp', path.join(tools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--lib', androidJar, '--min-api', '23', '--output', dex, ...walk(classes).filter(n => n.endsWith('.class'))]);
run(jdk('jar'), ['uf', resource, '-C', dex, 'classes.dex']);
run(exe('zipalign'), ['-f', '4', resource, aligned]);
const keystore = path.join(out, 'fixture-only.p12');
// Public disposable fixture signing material, not a production credential.
if (!fs.existsSync(keystore)) run(jdk('keytool'), ['-genkeypair', '-noprompt', '-keystore', keystore, '-storetype', 'PKCS12', '-storepass', 'fixture-only', '-keypass', 'fixture-only', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=M15 Disposable Isolated Fixture']);
run(jdk('java'), ['-jar', path.join(tools, 'lib', 'apksigner.jar'), 'sign', '--ks', keystore, '--ks-key-alias', 'fixture', '--ks-pass', 'pass:fixture-only', '--key-pass', 'pass:fixture-only', '--out', apk, aligned]);
run(jdk('java'), ['-jar', path.join(tools, 'lib', 'apksigner.jar'), 'verify', apk]);
console.log(JSON.stringify({ phase: 'build', built: true, apk, package: 'com.vcpchat.m15fixture', deviceAcceptance: 'NOT_RUN' }));
