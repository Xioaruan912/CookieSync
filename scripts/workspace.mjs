#!/usr/bin/env node
// Dependencies and generated files live outside this repository.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { assertOutsideSource, ownedPath } from './workspace-lib.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = args[0] || 'build';
if (!['build', 'verify'].includes(mode))
  throw new Error('Usage: node scripts/workspace.mjs build|verify [--cache path] [--output path]');
const option = (key, fallback) => {
  const index = args.indexOf(key);
  return index < 0 ? fallback : args[index + 1];
};
const identity = createHash('sha256').update(source).digest('hex').slice(0, 12);
const cache = path.resolve(option('--cache', path.join(os.tmpdir(), 'CookieSync-build', identity)));
const output = path.resolve(option('--output', path.join(path.dirname(source), path.basename(source) + '-release')));
const staging = path.join(cache, 'repo');
assertOutsideSource(source, cache);
assertOutsideSource(source, output);
await fs.mkdir(cache, { recursive: true });
assertOutsideSource(await fs.realpath(source), await fs.realpath(cache));
const cacheOwnerFile = path.join(cache, '.cookiesync-owner.json');
const cacheEntries = await fs.readdir(cache);
let cacheOwner;
try {
  cacheOwner = JSON.parse(await fs.readFile(cacheOwnerFile, 'utf8'));
} catch {}
if (cacheEntries.length && cacheOwner?.identity !== identity)
  throw new Error('缓存目录不是本项目的生成目录，请选择空的 --cache 目录');
await fs.writeFile(cacheOwnerFile, JSON.stringify({ identity }));
await fs.mkdir(output, { recursive: true });
assertOutsideSource(await fs.realpath(source), await fs.realpath(output));
const ownerFile = path.join(output, '.cookiesync-owner.json');
const outputEntries = await fs.readdir(output);
let owner;
try {
  owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
} catch {}
if (outputEntries.length && owner?.identity !== identity)
  throw new Error('输出目录不是本项目的生成目录，请选择一个空的 --output 目录');
await fs.writeFile(ownerFile, JSON.stringify({ identity }));
await fs.mkdir(staging, { recursive: true });
if ((await fs.lstat(staging)).isSymbolicLink()) throw new Error('Refusing linked build directory');
assertOutsideSource(await fs.realpath(source), await fs.realpath(staging));

function sourceFiles() {
  return [
    ...new Set(
      execFileSync('git', ['-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .toString()
        .split('\0')
        .filter(Boolean),
    ),
  ]
    .filter(
      file =>
        !file
          .split('/')
          .some(part => ['.git', 'node_modules', 'dist', 'build', '.turbo', '__pycache__'].includes(part)),
    )
    .filter(file => !/(^|\/)\.env(?:\.|$)|\.local\.json$|\.(zip|log|pyc|tsbuildinfo)$/.test(file))
    .sort();
}

async function snapshot() {
  const files = [];
  const hash = createHash('sha256');
  for (const file of sourceFiles()) {
    const absolute = ownedPath(source, file);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing source symlink: ${file}`);
    if (!stat.isFile()) continue;
    const data = await fs.readFile(absolute);
    hash.update(file + '\0').update(data);
    files.push(file);
  }
  return { files, digest: hash.digest('hex') };
}

async function synchronize(files) {
  const record = path.join(cache, 'source-files.json');
  let previous = [];
  try {
    previous = JSON.parse(await fs.readFile(record, 'utf8'));
  } catch {}
  for (const file of previous.filter(file => !files.includes(file)))
    await fs.rm(ownedPath(staging, file), { force: true });
  for (const file of files) {
    const target = ownedPath(staging, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(ownedPath(source, file), target);
  }
  await fs.writeFile(record, JSON.stringify(files));
}

async function pnpm(...command) {
  await new Promise((resolve, reject) => {
    const child = spawn('pnpm', command, {
      cwd: staging,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: 'inherit',
      env: { ...process.env, __DEV__: 'false', __FIREFOX__: 'false', TURBO_TELEMETRY_DISABLED: '1' },
    });
    child.on('error', reject);
    child.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`pnpm ${command.join(' ')} failed (${code})`)),
    );
  });
}

async function walk(root, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(path.join(root, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function publish(dist, destination) {
  await fs.mkdir(destination, { recursive: true });
  const files = await walk(dist);
  const record = path.join(
    cache,
    'published-' + createHash('sha256').update(destination).digest('hex').slice(0, 12) + '.json',
  );
  let old = [];
  try {
    old = JSON.parse(await fs.readFile(record, 'utf8'));
  } catch {}
  for (const file of old.filter(file => !files.includes(file)))
    await fs.rm(ownedPath(destination, file), { force: true });
  for (const file of files.filter(file => file !== 'manifest.json')) {
    const target = ownedPath(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(ownedPath(dist, file), target);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(dist, 'manifest.json'), 'utf8'));
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(record, JSON.stringify(files));
  return files;
}

async function build(current, verify) {
  await synchronize(current.files);
  await pnpm('install', '--frozen-lockfile', '--prod=false');
  const dist = ownedPath(staging, 'dist');
  // Only this generated cache/repo/dist is removed; never the desktop source.
  if (path.dirname(dist) !== staging || path.basename(dist) !== 'dist') throw new Error('Invalid generated dist');
  await fs.rm(dist, { force: true, recursive: true });
  await pnpm('build');
  if (verify) {
    await pnpm('type-check');
    await pnpm('test');
  }
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(dist, 'LICENSE'));
  await fs.copyFile(path.join(source, 'docs/WEBDAV.md'), path.join(dist, '使用说明.md'));
  await fs.copyFile(path.join(source, 'docs/GOOGLE.md'), path.join(dist, 'Google同步说明.md'));
  await fs.copyFile(path.join(source, 'PRIVACY.md'), path.join(dist, '隐私说明.md'));
  const files = await publish(dist, path.join(output, 'unpacked'));
  const require = createRequire(path.join(staging, 'packages/zipper/package.json'));
  const { zipSync } = require('fflate');
  const contents = {};
  for (const file of files) contents[file] = new Uint8Array(await fs.readFile(ownedPath(dist, file)));
  const version = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')).version;
  const archive = path.join(output, `CookieSync-chrome-${version}.zip`);
  await fs.writeFile(archive, zipSync(contents, { level: 6 }));
  console.log(`\n已生成：${archive}\n源码目录无依赖和构建产物。`);
}

try {
  await build(await snapshot(), mode === 'verify');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
