import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectFileList, ProjectFilePreview } from '../shared/project-files';

const maxEntries = 500;
const maxPreviewBytes = 1024 * 1024;
const excludedNames = new Set([
  '.git', '.beni', 'node_modules', '.aws', '.ssh', '.gnupg', '.npmrc', '.netrc', '.pypirc',
  'credentials', 'credentials.json', 'secrets', 'secrets.json', 'id_rsa', 'id_ed25519',
]);

function validName(name: string) {
  const lower = name.toLowerCase();
  return name !== '' && name !== '.' && name !== '..' && !/[\\:\x00-\x1f\x7f]/.test(name)
    && !excludedNames.has(lower) && !/^\.env(?:\.|$)/.test(lower)
    && !/\.(?:pem|key|p12|pfx)$/.test(lower);
}

export function validProjectFilePath(path: string) {
  return path.length <= 4096 && (path === '' || path.split('/').every(validName));
}

function sameFile(first: Stats, second: Stats) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function projectEntry(folder: string, path: string) {
  const root = await realpath(folder);
  let target = root;
  if (path) {
    for (const name of path.split('/')) {
      target = join(target, name);
      if ((await lstat(target)).isSymbolicLink()) throw Error('Invalid project entry');
    }
  }
  return { target, original: await lstat(target) };
}

// 開いた対象が、検証したプロジェクト内のパスと同じ対象かを確認する。
async function verifyEntry(target: string, original: Stats) {
  if (await realpath(target) !== target || !sameFile(original, await lstat(target))) {
    throw Error('Project entry changed');
  }
}

export async function listProjectFiles(folder: string, path: string): Promise<ProjectFileList> {
  const { target, original } = await projectEntry(folder, path);
  if (!original.isDirectory()) throw Error('Not a directory');
  await verifyEntry(target, original);
  const entries: ProjectFileList['entries'] = [];
  let truncated = false;
  for await (const entry of await opendir(target)) {
    if (!validName(entry.name) || (!entry.isDirectory() && !entry.isFile())) continue;
    if (entries.length === maxEntries) { truncated = true; break; }
    entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
  }
  await verifyEntry(target, original);
  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'ja', { numeric: true }));
  return { entries, truncated };
}

export async function readProjectFile(folder: string, path: string): Promise<ProjectFilePreview> {
  const { target, original } = await projectEntry(folder, path);
  if (!original.isFile() || original.nlink !== 1) throw Error('Not a project file');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(original, opened)) throw Error('Project file changed');
    await verifyEntry(target, opened);
    if (opened.size > maxPreviewBytes) return { kind: 'too-large' };

    const bytes = Buffer.alloc(maxPreviewBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxPreviewBytes) return { kind: 'too-large' };
    const after = await file.stat();
    if (after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw Error('Project file changed while reading');
    }
    await verifyEntry(target, opened);
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      if (/[\x00-\x08\x0e-\x1f\x7f]/.test(content)) return { kind: 'binary' };
      return { kind: 'text', content };
    } catch {
      return { kind: 'binary' };
    }
  } finally {
    await file.close();
  }
}
