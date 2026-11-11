import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export function directoryStat(path: string) {
  if (!lstatSync(path).isDirectory()) throw Error('Invalid data directory');
}

export function fileStat(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw Error('Invalid data file');
  return stat;
}

function sameFile(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino;
}

export function withFile<T>(path: string, before: Stats, read: (fd: number) => T) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, before)) throw Error('Data file changed');
    return read(fd);
  } finally {
    closeSync(fd);
  }
}

export function openDataDatabase<T extends {close(): void}>(path: string, open: (path: string) => T) {
  // 設定された保存ルートより上の OS 管理の別名を解決する。DB の直上とファイル自体はリンクを拒否する。
  const parent = dirname(path), parentStat = lstatSync(parent);
  if (!parentStat.isDirectory()) throw Error('Invalid database directory');
  const canonicalParent = realpathSync(parent);
  if (!sameFile(parentStat,lstatSync(canonicalParent))) throw Error('Database directory changed');
  path = join(canonicalParent,basename(path));
  const before = fileStat(path);
  for (const suffix of ['-journal','-wal','-shm']) {
    try { fileStat(path + suffix); } catch (error) { if (!absent(error)) throw error; }
  }
  // WAL を開くと SQLite が共有メモリーを作成・更新する場合があるため、保存側と同じ rollback journal のみ読む。
  const mode = Buffer.alloc(2);
  withFile(path, before, fd => {
    if (readSync(fd, mode, 0, mode.length, 18) !== mode.length || mode[0] !== 1 || mode[1] !== 1) throw Error('Unsupported database journal');
  });
  const db = open(path);
  try {
    if (!sameFile(before, fileStat(path))) throw Error('Data file changed');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
