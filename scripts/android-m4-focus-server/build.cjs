'use strict';
// Fixed upstream source + one virtual-display flag. No Gradle, download, ADB or vendor overwrite.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const CANDIDATE = 'scrcpy-5.0.1-focus1';
const COMMIT = 'a60891aea193d92e7e5c3942700eca63f9d19a5f';
const TARGET = 'server/src/main/java/com/genymobile/scrcpy/video/NewDisplayCapture.java';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const fail = text => { throw new Error(text); };
const args = process.argv.slice(2);
if (args.includes('--help')) {
    console.log('node scripts/android-m4-focus-server/build.cjs --sdk F:/AndroidSdk [--jdk JDK] [--source FIXED_UPSTREAM_CHECKOUT] [--platform android-36] [--build-tools 36.0.0]');
    process.exit(0);
}
const options = {};
for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--sdk', '--jdk', '--source', '--platform', '--build-tools'].includes(key)
        || Object.hasOwn(options, key) || !args[index + 1] || args[index + 1].startsWith('--')) fail('Invalid or duplicated build option');
    options[key] = args[index + 1];
}
const sdk = path.resolve(options['--sdk'] || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || fail('Supply --sdk'));
const source = path.resolve(options['--source'] || path.join(__dirname, '../../artifacts/android-m4-focus-2026-11-06/upstream'));
const jdk = path.resolve(options['--jdk'] || path.join(sdk, 'jbr'));
const platform = options['--platform'] || 'android-36';
const version = options['--build-tools'] || '36.0.0';
if (!/^android-36(?:\.1)?$/.test(platform) || !/^36\.0\.0$/.test(version)) fail('This candidate is frozen to platform 36/36.1 and build-tools 36.0.0');
const suffix = process.platform === 'win32' ? '.exe' : '';
const java = name => path.join(jdk, 'bin', name + suffix);
const tools = path.join(sdk, 'build-tools', version);
const androidJar = path.join(sdk, 'platforms', platform, 'android.jar');
const androidAidl = path.join(sdk, 'platforms', platform, 'framework.aidl');
const lambdaJar = path.join(tools, 'core-lambda-stubs.jar');
const aidl = path.join(tools, 'aidl' + suffix);
const d8 = path.join(tools, 'lib/d8.jar');
for (const file of [java('java'), java('javac'), java('jar'), androidJar, androidAidl, lambdaJar, aidl, d8]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail('Missing installed build dependency: ' + file);
}
const git = args => {
    const result = cp.spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) fail('Cannot verify fixed upstream checkout: ' + (result.stderr || result.error?.message));
    return result.stdout.trim();
};
if (git(['rev-parse', 'HEAD']) !== COMMIT) fail('Unexpected upstream commit');
if (git(['status', '--porcelain', '--untracked-files=all'])) fail('Upstream checkout must be clean');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail('Unexpected symlink in build input: ' + file);
    return entry.isDirectory() ? walk(file) : [file];
});
const inputs = [path.join(source, 'LICENSE'), path.join(source, 'server/build_without_gradle.sh'),
    ...walk(path.join(source, 'server/src/main/java')), ...walk(path.join(source, 'server/src/main/aidl'))].sort();
const sourceFiles = inputs.map(file => ({ path: path.relative(source, file).replaceAll('\\', '/'), sha256: hashFile(file) }));
const output = path.join(__dirname, '.build');
fs.mkdirSync(output, { recursive: true });
const work = fs.mkdtempSync(path.join(output, 'work-'));
const stage = path.join(work, 'source');
const classes = path.join(work, 'classes');
const gen = path.join(work, 'gen');
for (const folder of [stage, classes, gen]) fs.mkdirSync(folder, { recursive: true });
fs.cpSync(path.join(source, 'server/src/main'), path.join(stage, 'server/src/main'), { recursive: true });
const stagedTarget = path.join(stage, TARGET);
const original = fs.readFileSync(stagedTarget, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const replaceOnce = (text, from, to) => {
    if (text.split(from).length !== 2) fail('Frozen patch context is not unique');
    return text.replace(from, to);
};
const constant = '    private static final int VIRTUAL_DISPLAY_FLAG_DEVICE_DISPLAY_GROUP = 1 << 15;';
const branch = '                    flags |= VIRTUAL_DISPLAY_FLAG_OWN_FOCUS' + eol
    + '                            | VIRTUAL_DISPLAY_FLAG_DEVICE_DISPLAY_GROUP;';
let patched = replaceOnce(original, constant, constant + eol
    + '    private static final int VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED = 1 << 16;');
patched = replaceOnce(patched, branch, '                    flags |= VIRTUAL_DISPLAY_FLAG_OWN_FOCUS' + eol
    + '                            | VIRTUAL_DISPLAY_FLAG_DEVICE_DISPLAY_GROUP' + eol
    + '                            | VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED;');
fs.writeFileSync(stagedTarget, patched);
const configPath = path.join(gen, 'com/genymobile/scrcpy/BuildConfig.java');
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, 'package com.genymobile.scrcpy;\npublic final class BuildConfig {\n'
    + ' public static final boolean DEBUG = false;\n public static final String VERSION_NAME = "5.0.1";\n}\n');
const commands = [];
const log = path.join(work, 'build.log');
function run(file, argv, cwd = work) {
    const result = cp.spawnSync(file, argv, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    commands.push({ file, args: argv, cwd, exitCode: result.status, error: result.error?.message || null });
    fs.appendFileSync(log, result.stdout || '');
    fs.appendFileSync(log, result.stderr || '');
    fs.writeFileSync(path.join(work, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) fail('Build command failed: ' + path.basename(file));
    return result.stdout;
}
const aidlSource = path.join(stage, 'server/src/main/aidl');
run(aidl, ['-o' + gen, '-I' + aidlSource, path.join(aidlSource, 'android/content/IOnPrimaryClipChangedListener.aidl')]);
run(aidl, ['-o' + gen, '-I' + aidlSource, '-p', androidAidl, path.join(aidlSource, 'android/view/IDisplayWindowListener.aidl')]);
const javaFiles = [...walk(path.join(stage, 'server/src/main/java')), ...walk(gen)].filter(file => file.endsWith('.java')).sort();
const javacArgs = ['-encoding', 'UTF-8', '-bootclasspath', androidJar, '-classpath', lambdaJar + path.delimiter + gen,
    '-d', classes, '-source', '1.8', '-target', '1.8', ...javaFiles];
const quoteArgument = arg => '"' + arg.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
const argumentFile = path.join(work, 'javac.args');
fs.writeFileSync(argumentFile, javacArgs.map(quoteArgument).join('\n') + '\n');
run(java('javac'), ['@' + argumentFile]);
const classArchive = path.join(work, 'classes.jar');
run(java('jar'), ['cf', classArchive, '-C', classes, '.']);
const dexArchive = path.join(work, 'scrcpy-server-focus1.jar');
run(java('java'), ['-cp', d8, 'com.android.tools.r8.D8', '--classpath', androidJar, '--min-api', '21', '--output', dexArchive, classArchive]);
const entries = run(java('jar'), ['tf', dexArchive]).trim().split(/\r?\n/);
if (entries.length !== 1 || entries[0] !== 'classes.dex') fail('Unexpected candidate archive entries');
const artifact = path.join(output, 'scrcpy-server-focus1.jar');
fs.copyFileSync(dexArchive, artifact);
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE.scrcpy'));
const evidence = {
    candidate: CANDIDATE, upstreamCommit: COMMIT, upstreamVersion: '5.0.1',
    upstreamRepository: 'https://github.com/Genymobile/scrcpy', upstreamSource: source,
    buildModel: 'server/build_without_gradle.sh; local AIDL + javac + D8; no Gradle or network',
    sdk, jdk, platform, buildTools: version, sdkAndroidJarSha256: hashFile(androidJar), d8Sha256: hashFile(d8),
    artifact, sha256: hashFile(artifact), bytes: fs.statSync(artifact).size, entries,
    sourceTreeSha256: sha(JSON.stringify(sourceFiles)), sourceFiles,
    patch: { path: path.join(__dirname, 'focus1.patch'), sha256: hashFile(path.join(__dirname, 'focus1.patch')),
        target: TARGET, beforeSha256: sha(Buffer.from(original)), afterSha256: hashFile(stagedTarget),
        minimumApi: 34, flag: 'VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED', flagValue: 65536,
        semantics: 'Preserve TRUSTED/OWN_FOCUS; prevent virtual display stealing top focus; IME hide remains a host policy' },
    builderSha256: hashFile(__filename), generatedBuildConfigSha256: hashFile(configPath),
    license: { spdx: 'Apache-2.0', url: `https://github.com/Genymobile/scrcpy/blob/${COMMIT}/LICENSE`,
        path: path.join(output, 'LICENSE.scrcpy'), sha256: hashFile(path.join(source, 'LICENSE')) },
    commands: path.join(work, 'commands.json'), log, stagedPatchedSource: stagedTarget,
    deviceAcceptance: 'NOT_RUN', productionPromotion: false,
};
fs.writeFileSync(path.join(output, 'build-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ candidate: CANDIDATE, upstreamCommit: COMMIT, artifact, sha256: evidence.sha256,
    bytes: evidence.bytes, evidence: path.join(output, 'build-evidence.json'), deviceAcceptance: evidence.deviceAcceptance }));
