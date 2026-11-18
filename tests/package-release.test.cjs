'use strict';

// Exercise packaging with an in-memory filesystem. Do not read private files or create releases.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const scriptFile = path.join(root, 'scripts', 'package-release.cjs');
const script = fs.readFileSync(scriptFile, 'utf8');
const allowed = ['index.html', 'styles.css', 'appearance.css', 'engine.js', 'mortgage.js', 'preferences.js',
  'app.js', '打开CoWallet.cmd', 'README.md', '.gitignore',
  'tests/engine.test.cjs', 'tests/mortgage.test.cjs', 'tests/preferences.test.cjs',
  'tests/planning-integration.test.cjs',
  'tests/plans.test.cjs', 'tests/package-release.test.cjs',
  'scripts/package-release.cjs'];
const sourceIndex = '<!doctype html>\n<html><head><meta charset="UTF-8">\n<meta name="cowallet-channel" content="local">\n<title>虚构例子</title></head><body>本机页面</body></html>\n';
const releasedIndex = sourceIndex.replace('content="local"', 'content="release"');
function expectedBytes(name, release = false) {
  if (name === 'index.html') return Buffer.from(release ? releasedIndex : sourceIndex);
  if (name === 'styles.css') return Buffer.from([0, 0xff, 0x80, 0x41, 0xc0, 0xed]);
  return Buffer.from(`public source: ${name}`);
}

function runPackager(index = sourceIndex, args = []) {
const paths = new Map(allowed.map(name => [path.resolve(root, name),
  name === 'index.html' ? Buffer.from(index) : expectedBytes(name)]));
const reads = [], writes = [], logs = [];
const mkdirs = [];
const memoryFs = {
  realpathSync: file => path.resolve(file),
  lstatSync: file => ({
    isSymbolicLink: () => false,
    isFile: () => paths.has(path.resolve(file))
  }),
  readFileSync: file => {
    const resolved = path.resolve(file);
    assert.ok(paths.has(resolved), '打包器不能读取白名单之外的文件');
    reads.push(resolved);
    return paths.get(resolved);
  },
  mkdirSync: file => mkdirs.push(file),
  writeFileSync: (file, data, options) => {
    assert.equal(options.flag, 'wx', '发行文件必须拒绝覆盖');
    writes.push({ file, data });
  },
  readdirSync: () => { throw Error('打包器不能遍历个人文件目录'); },
  unlinkSync: () => { throw Error('打包器不能删除文件'); },
  rmSync: () => { throw Error('打包器不能删除文件'); }
};
const processStub = { argv: ['node', scriptFile, ...args], exitCode: 0 };
vm.runInNewContext(script, {
  __dirname: path.dirname(scriptFile), Buffer, process: processStub,
  require: name => {
    if (name === 'node:fs') return memoryFs;
    if (name === 'node:path') return path;
    if (name === 'node:zlib') return zlib;
    throw Error('打包器只能使用本地文件、路径与压缩模块');
  },
  console: { log: message => logs.push(String(message)), error: message => logs.push(String(message)) }
});
return { paths, reads, writes, logs, mkdirs, processStub };
}

const { paths, reads, writes, logs, processStub } = runPackager();
assert.equal(processStub.exitCode, 0);
assert.equal(reads.length, allowed.length);
assert.equal(writes.length, 1);
assert.equal(writes[0].file, path.join(root, 'releases', 'CoWallet-1.1.zip'));
const archive = writes[0].data;
const entries = [];
let offset = 0;
while (archive.readUInt32LE(offset) === 0x04034b50) {
  assert.equal(archive.readUInt16LE(offset + 6) & 0x0800, 0x0800, '中文文件名使用UTF-8标记');
  assert.equal(archive.readUInt16LE(offset + 8), 8, '使用标准deflate压缩');
  const size = archive.readUInt32LE(offset + 18);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
  const bodyStart = offset + 30 + nameLength + extraLength;
  const body = zlib.inflateRawSync(archive.subarray(bodyStart, bodyStart + size));
  const relative = name.replace(/^CoWallet-1\.1\//, '');
  assert.ok(allowed.includes(relative), 'ZIP条目必须来自白名单');
  assert.ok(body.equals(expectedBytes(relative, true)), '除index渠道标记外，发布内容逐字节保留');
  assert.ok(!/\.(?:png|jpg|json|csv|log|env)$|(?:^|\/)\.git(?:\/|$)/i.test(name));
  entries.push(relative);
  offset = bodyStart + size;
}
assert.deepEqual(entries, allowed);
assert.equal(archive.readUInt32LE(offset), 0x02014b50);
assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
assert.equal(archive.readUInt16LE(archive.length - 12), allowed.length);
assert.ok(logs.every(message => !/public source:/.test(message)), '日志不输出文件内容');
for (const name of allowed) assert.ok(paths.get(path.resolve(root, name)).equals(expectedBytes(name)), '源文件不变');

const directory = runPackager(sourceIndex, ['--directory']);
assert.equal(directory.processStub.exitCode, 0);
assert.equal(directory.writes.length, allowed.length);
for (const file of directory.writes) {
  const relative = path.relative(path.join(root, 'releases', 'CoWallet-1.1'), file.file).split(path.sep).join('/');
  assert.ok(allowed.includes(relative));
  assert.ok(file.data.equals(expectedBytes(relative, true)));
}
for (const invalid of [
  '<html><head></head><body></body></html>',
  sourceIndex.replace('content="local"', 'content="release"'),
  sourceIndex.replace('</head>', '<meta name="cowallet-channel" content="local"></head>'),
  '<html><head><!-- <meta name="cowallet-channel" content="local"> --></head></html>',
  '<html><head></head><body><meta name="cowallet-channel" content="local"></body></html>',
  sourceIndex.replace('content="local"', 'content="local" content="local"')
]) {
  const rejected = runPackager(invalid);
  assert.equal(rejected.processStub.exitCode, 1, '缺失、重复或错误的meta应拒绝打包');
  assert.equal(rejected.writes.length, 0, '校验失败不得写出发布文件');
  assert.equal(rejected.mkdirs.length, 0, '校验失败不得创建发布目录');
}
const savings = runPackager(sourceIndex, ['--suffix', 'savings']);
assert.equal(savings.processStub.exitCode, 0);
assert.equal(savings.writes[0].file, path.join(root, 'releases', 'CoWallet-1.1-savings.zip'));
let savingsOffset = 0, savingsEntries = 0;
while (savings.writes[0].data.readUInt32LE(savingsOffset) === 0x04034b50) {
  const data = savings.writes[0].data;
  const size = data.readUInt32LE(savingsOffset + 18);
  const nameLength = data.readUInt16LE(savingsOffset + 26);
  const extraLength = data.readUInt16LE(savingsOffset + 28);
  const name = data.subarray(savingsOffset + 30, savingsOffset + 30 + nameLength).toString('utf8');
  assert.ok(name.startsWith('CoWallet-1.1-savings/'));
  const relative = name.slice('CoWallet-1.1-savings/'.length);
  const start = savingsOffset + 30 + nameLength + extraLength;
  assert.ok(zlib.inflateRawSync(data.subarray(start, start + size)).equals(expectedBytes(relative, true)));
  savingsEntries += 1;
  savingsOffset = start + size;
}
assert.equal(savingsEntries, allowed.length);
const savingsDirectory = runPackager(sourceIndex, ['--directory', '--suffix', 'savings']);
assert.equal(savingsDirectory.processStub.exitCode, 0);
for (const file of savingsDirectory.writes) {
  const relative = path.relative(path.join(root, 'releases', 'CoWallet-1.1-savings'), file.file).split(path.sep).join('/');
  assert.ok(allowed.includes(relative));
  assert.ok(file.data.equals(expectedBytes(relative, true)));
}
for (const suffix of ['../private', '..', 'a/b', '', 'Savings', 'valid--bad', 'x'.repeat(41)]) {
  const invalid = runPackager(sourceIndex, ['--suffix', suffix]);
  assert.equal(invalid.processStub.exitCode, 1);
  assert.equal(invalid.reads.length, 0);
  assert.equal(invalid.writes.length, 0);
}
console.log(`发行包内存测试通过：${allowed.length}项白名单、ZIP/目录渠道与字节守恒、安全后缀、非法meta和路径拒绝。`);
