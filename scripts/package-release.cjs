'use strict';

// Local packaging only. Read only these source files; never enumerate or scan user data.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const VERSION = '1.1';
const ROOT = path.resolve(__dirname, '..');
const FILES = Object.freeze([
  'index.html', 'styles.css', 'appearance.css', 'engine.js', 'mortgage.js', 'preferences.js',
  'app.js', '打开CoWallet.cmd', 'README.md', '.gitignore',
  'tests/engine.test.cjs', 'tests/mortgage.test.cjs', 'tests/preferences.test.cjs',
  'tests/planning-integration.test.cjs',
  'tests/plans.test.cjs', 'tests/package-release.test.cjs',
  'scripts/package-release.cjs'
]);

function insideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function releaseIndex(data) {
  const html = data.toString('utf8');
  if (!Buffer.from(html, 'utf8').equals(data)) throw new Error('index.html 必须使用有效UTF-8编码。');
  // Ignore inert text while preserving string positions. The marker must be a real head meta.
  const masked = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
    text => ' '.repeat(text.length));
  const heads = [...masked.matchAll(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi)];
  const markers = [...masked.matchAll(/<meta\b[^>]*>/gi)].filter(match =>
    /\sname\s*=\s*(["'])cowallet-channel\1(?=\s|\/?>)/i.test(match[0]));
  if (heads.length !== 1 || markers.length !== 1 || markers[0].index < heads[0].index ||
      markers[0].index + markers[0][0].length > heads[0].index + heads[0][0].length) {
    throw new Error('index.html 的head内必须恰好有一个cowallet-channel meta。');
  }
  const marker = markers[0];
  const tag = html.slice(marker.index, marker.index + marker[0].length);
  const contents = [...tag.matchAll(/\scontent\s*=\s*(["'])(.*?)\1/gi)];
  if (contents.length !== 1 || contents[0][2] !== 'local') {
    throw new Error('源index.html的cowallet-channel必须使用唯一的content="local"。');
  }
  const releasedTag = tag.replace(/(\scontent\s*=\s*)(["'])local\2/i,
    (_match, prefix, quote) => `${prefix}${quote}release${quote}`);
  return Buffer.from(html.slice(0, marker.index) + releasedTag +
    html.slice(marker.index + marker[0].length), 'utf8');
}

function readAllowedFiles() {
  const realRoot = fs.realpathSync(ROOT);
  return FILES.map(name => {
    const source = path.resolve(ROOT, name);
    const info = fs.lstatSync(source);
    if (!insideRoot(source, ROOT) || info.isSymbolicLink() || !info.isFile() ||
        !insideRoot(fs.realpathSync(source), realRoot)) {
      throw new Error(`白名单文件不是项目内的普通文件：${name}`);
    }
    const data = fs.readFileSync(source);
    return { name, data: name === 'index.html' ? releaseIndex(data) : data };
  });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files, prefix) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`${prefix}/${file.name}`, 'utf8');
    const compressed = zlib.deflateRawSync(file.data, { level: 9 });
    const checksum = crc32(file.data);
    // Fixed 1980-01-01 timestamps avoid embedding machine metadata in releases.
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names, including the Windows launcher.
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    localParts.push(header, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function parseOptions(args) {
  const options = { directory: false, list: false, suffix: '' };
  let hasSuffix = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--directory' && !options.directory) options.directory = true;
    else if (arg === '--list' && !options.list) options.list = true;
    else if (arg === '--suffix' && !hasSuffix && i + 1 < args.length) {
      const suffix = args[++i];
      if (suffix.length > 40 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suffix)) {
        throw new Error('发行后缀须为1–40位小写字母、数字或单个连字符分隔的名称。');
      }
      options.suffix = suffix;
      hasSuffix = true;
    } else throw new Error('用法：node scripts/package-release.cjs [--directory] [--list] [--suffix savings]');
  }
  options.prefix = `CoWallet-${VERSION}${options.suffix ? '-' + options.suffix : ''}`;
  return options;
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.list) {
    console.log(FILES.join('\n'));
    return;
  }
  const files = readAllowedFiles();
  const releases = path.join(ROOT, 'releases');
  fs.mkdirSync(releases, { recursive: true });
  if (fs.lstatSync(releases).isSymbolicLink() ||
      !insideRoot(fs.realpathSync(releases), fs.realpathSync(ROOT))) {
    throw new Error('releases 必须是项目目录内的普通目录。');
  }
  if (options.directory) {
    const destination = path.join(releases, options.prefix);
    fs.mkdirSync(destination); // Refuse to replace existing files or directories.
    for (const file of files) {
      const target = path.resolve(destination, file.name);
      if (!insideRoot(target, destination)) throw new Error('发布文件路径超出目标目录。');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.data, { flag: 'wx' });
    }
    console.log(`已生成 releases/${options.prefix}/（${files.length} 个白名单文件）。`);
  } else {
    fs.writeFileSync(path.join(releases, `${options.prefix}.zip`), zip(files, options.prefix), { flag: 'wx' });
    console.log(`已生成 releases/${options.prefix}.zip（${files.length} 个白名单文件）。`);
  }
  console.log('仅生成本地发布副本；未读取备份/截图/浏览器数据，未连接或发布到 GitHub。');
}

try { main(); }
catch (error) {
  if (error.code === 'EEXIST') console.error('目标已存在，已停止；不会覆盖或删除原文件。');
  else console.error(error.message);
  process.exitCode = 1;
}
