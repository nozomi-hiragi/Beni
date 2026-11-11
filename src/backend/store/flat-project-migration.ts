import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, constants, copyFileSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { validProjectId } from '../../shared/ids';
import { metadata, readJson } from '../data';
import { projectIdentity } from '../project-events';

const databaseNames = ['project.sqlite', 'events.sqlite'] as const;
const sidecars = ['-wal', '-shm', '-journal'] as const;
const superJournalName = /^(?:project|events)\.sqlite-mj[0-9a-f]{6}9[0-9a-f]{2}$/i;
const journalMagic = Buffer.from('d9d505f920a163d7', 'hex');
const digestPattern = /^[0-9a-f]{64}$/;
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const fileVersion = (stat: Stats) => `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const statIfPresent = (path: string) => lstatSync(path, {throwIfNoEntry: false});

type Manifest = {
  version: 1;
  projectId: string;
  sourceDirectory: string;
  sourceDatabase: typeof databaseNames[number];
  sources: Record<string, string>;
  destinationDigest: string;
};

function fileStat(path: string, links = 1) {
  const stat = statIfPresent(path);
  if (stat && (!stat.isFile() || stat.nlink !== links)) throw Error('Invalid migration file');
  return stat;
}

function directoryStat(path: string) {
  const stat = statIfPresent(path);
  if (stat && !stat.isDirectory()) throw Error('Invalid migration directory');
  return stat;
}

function fingerprint(path: string, expected: Stats) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (fileVersion(opened) !== fileVersion(expected) || opened.nlink !== expected.nlink) throw Error('Migration file changed');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, count));
    if (fileVersion(fstatSync(fd)) !== fileVersion(opened)) throw Error('Migration file changed');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

function syncPath(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function rejectSuperJournal(path: string) {
  const stat = fileStat(path);
  if (!stat || stat.size < 16) return;
  // 複数 DB のロールバックはジャーナル末尾のパスを参照する。複製だけで復旧できる形式に限る。
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fileVersion(fstatSync(fd)) !== fileVersion(stat)) throw Error('Migration file changed');
    const trailer = Buffer.alloc(8);
    if (readSync(fd, trailer, 0, trailer.length, stat.size - trailer.length) !== trailer.length) throw Error('Migration file changed');
    if (trailer.equals(journalMagic)) throw Error('SQLite super-journal is unsupported');
  } finally { closeSync(fd); }
}

export function projectDatabaseMigrationStage(databasePath: string) {
  return join(dirname(databasePath), `.${basename(databasePath)}.migration`);
}

function sourceFiles(directory: string) {
  if (!directoryStat(directory)) return;
  if (readdirSync(directory).some(entry => superJournalName.test(entry))) throw Error('SQLite super-journal is unsupported');
  const databases = databaseNames.map(name => {
    const main = fileStat(join(directory, name));
    const files = sidecars.map(suffix => [suffix, fileStat(join(directory, name + suffix))] as const);
    if (!main) {
      if (files.some(([, stat]) => stat)) throw Error('Orphaned SQLite sidecar');
      return;
    }
    return {name, files: [['', main] as const, ...files.filter((entry): entry is readonly [typeof sidecars[number], Stats] => !!entry[1])]};
  }).filter(entry => entry !== undefined);
  if (databases.length > 1) throw Error('Both legacy project databases exist');
  return databases[0];
}

function sourceVersion(path: string, stat: Stats) {
  return `${fileVersion(stat)}:${fingerprint(path, stat)}`;
}

function verifyIntegrity(db: Database) {
  const results = db.query<{integrity_check: string}, []>('PRAGMA integrity_check').all();
  if (results.length !== 1 || results[0]?.integrity_check !== 'ok') throw Error('Invalid project database');
}

function discardRecoveredSidecars(path: string) {
  for (const suffix of sidecars) {
    const sidecar = path + suffix, stat = fileStat(sidecar);
    if (!stat) continue;
    if (suffix === '-journal' && stat.size > 0) {
      // PERSIST モードの確定済みジャーナルはヘッダーだけが無効化されている。
      const fd = openSync(sidecar, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(8);
        readSync(fd, header, 0, header.length, 0);
        if (header.some(byte => byte !== 0)) throw Error('SQLite journal remains after recovery');
      } finally { closeSync(fd); }
    } else if (suffix === '-wal' && stat.size > 0) throw Error('SQLite WAL remains after recovery');
    unlinkSync(sidecar);
  }
}

function recoverSnapshot(path: string, legacyDirectory: string, projectId: string) {
  rejectSuperJournal(path + '-journal');
  const db = new Database(path, {readwrite: true, create: false, strict: true});
  try {
    verifyIntegrity(db);
    const previous = projectIdentity(db);
    if (previous === undefined) {
      const legacyMetadata = join(legacyDirectory, 'project.json');
      if (!fileStat(legacyMetadata) || metadata(legacyMetadata, 'project').id !== projectId) throw Error('Project database identity is missing or mismatched');
      db.transaction(() => {
        db.exec('CREATE TABLE project_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), project_id TEXT NOT NULL)');
        db.query('INSERT INTO project_identity(singleton,project_id) VALUES (1,?)').run(projectId);
      }).immediate();
    } else if (previous !== projectId) throw Error('Project ID mismatch');
    const checkpoint = db.query<{busy: number; log: number; checkpointed: number}, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (!checkpoint || checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) throw Error('Could not checkpoint project database');
    if (db.query<{journal_mode: string}, []>('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') throw Error('Could not close project database journal');
  } finally { db.close(); }
  discardRecoveredSidecars(path);
  const recovered = new Database(path, {readonly: true, create: false, strict: true});
  try {
    verifyIntegrity(recovered);
    if (projectIdentity(recovered) !== projectId) throw Error('Project ID mismatch');
  } finally { recovered.close(); }
}

function readManifest(path: string, projectId: string): Manifest {
  const value = readJson(path);
  if (value?.version !== 1 || value.projectId !== projectId || !/^\d+:\d+$/.test(value.sourceDirectory) ||
      !databaseNames.includes(value.sourceDatabase) || !digestPattern.test(value.destinationDigest) ||
      !value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources) ||
      !Object.hasOwn(value.sources, '') || Object.entries(value.sources).some(([suffix, version]) =>
        suffix !== '' && !sidecars.some(name => name === suffix) || typeof version !== 'string' || !digestPattern.test(version.split(':').at(-1)!))) {
    throw Error('Invalid project database migration record');
  }
  return value;
}

function validateSource(directory: string, manifest: Manifest, published: boolean) {
  const root = directoryStat(directory), source = sourceFiles(directory);
  if (root && identity(root) !== manifest.sourceDirectory || source && source.name !== manifest.sourceDatabase ||
      !published && source?.files.length !== Object.keys(manifest.sources).length) throw Error('Migration source changed');
  for (const [suffix, stat] of source?.files ?? []) {
    const path = join(directory, manifest.sourceDatabase + suffix);
    if (sourceVersion(path, stat) !== manifest.sources[suffix]) throw Error('Migration source changed');
  }
  return source;
}

/** Move a stopped project's database, recovering journals on the copy. Callers serialize migration. */
export function flattenProjectDatabase(legacyDirectory: string, databasePath: string, projectId: string): boolean {
  if (!validProjectId(projectId)) throw Error('Invalid project ID');
  const destination = resolve(databasePath), parent = dirname(destination);
  if (!directoryStat(parent)) throw Error('Missing project database directory');
  const stage = projectDatabaseMigrationStage(destination);
  const snapshot = join(stage, 'database.sqlite');
  const manifestPath = join(stage, 'manifest.json');
  const pendingPath = join(stage, 'manifest.pending');
  const legacy = sourceFiles(legacyDirectory);
  const existingStage = directoryStat(stage);
  if (!legacy && !existingStage) return false;
  if (sidecars.some(suffix => statIfPresent(destination + suffix))) throw Error('Project database destination has a sidecar');

  const target = statIfPresent(destination), staged = statIfPresent(snapshot);
  const published = !!target && !!staged && sameFile(target, staged);
  const finishedCleanup = !!target && !!existingStage && !legacy && !staged && readdirSync(stage).length === 0;
  if (target && !published && !finishedCleanup) throw Error('Project database destination already exists');
  if (target) fileStat(destination, published ? 2 : 1);
  if (existingStage) {
    const allowed = [snapshot, manifestPath, pendingPath, ...sidecars.map(suffix => snapshot + suffix)];
    for (const entry of readdirSync(stage)) {
      const path = join(stage, entry);
      if (!allowed.includes(path)) throw Error('Unexpected project database migration file');
      fileStat(path, path === snapshot && published ? 2 : 1);
    }
  } else mkdirSync(stage, {mode: 0o700});

  if (!fileStat(manifestPath)) {
    if (published && legacy) throw Error('Missing project database migration record');
    if (!published && !legacy && readdirSync(stage).length) throw Error('Missing project database migration source');
    // 公開前の不完全な複製、または片付けを終えた後に残った作業ファイルを再試行で取り除く。
    for (const path of [...sidecars.map(suffix => snapshot + suffix), pendingPath, snapshot]) {
      if (statIfPresent(path)) unlinkSync(path);
    }
    if (!legacy) {
      rmdirSync(stage);
      syncPath(parent);
      return true;
    }

    const root = directoryStat(legacyDirectory);
    if (!root) throw Error('Migration source changed');
    const sources: Manifest['sources'] = {};
    for (const [suffix, stat] of legacy.files) {
      const original = join(legacyDirectory, legacy.name + suffix);
      sources[suffix] = sourceVersion(original, stat);
      // 共有メモリは WAL の索引なので、複製側では SQLite が再構築する。
      if (suffix === '-shm') continue;
      const copy = snapshot + suffix;
      copyFileSync(original, copy, constants.COPYFILE_EXCL);
      const copied = fileStat(copy)!;
      if (!sources[suffix].endsWith(`:${fingerprint(copy, copied)}`)) throw Error('Migration copy differs');
      chmodSync(copy, 0o600);
    }
    recoverSnapshot(snapshot, legacyDirectory, projectId);
    syncPath(snapshot);
    const manifest: Manifest = {
      version: 1, projectId, sourceDirectory: identity(root), sourceDatabase: legacy.name, sources,
      destinationDigest: fingerprint(snapshot, fileStat(snapshot)!),
    };
    validateSource(legacyDirectory, manifest, false);
    writeFileSync(pendingPath, JSON.stringify(manifest), {flag: 'wx', mode: 0o600});
    syncPath(pendingPath);
    renameSync(pendingPath, manifestPath);
    syncPath(stage);
    syncPath(parent);
  }

  const manifest = readManifest(manifestPath, projectId);
  if (fileStat(pendingPath)) throw Error('Unexpected pending project database migration record');
  const snapshotStat = fileStat(snapshot, published ? 2 : 1);
  if (!snapshotStat || fingerprint(snapshot, snapshotStat) !== manifest.destinationDigest ||
      sidecars.some(suffix => fileStat(snapshot + suffix))) throw Error('Invalid project database migration snapshot');
  const source = validateSource(legacyDirectory, manifest, published);
  // ハードリンクは既存の移行先を上書きしない。両パスの inode が同じ場合だけ公開済みと判断する。
  if (!published) linkSync(snapshot, destination);
  syncPath(parent);

  if (source) {
    for (const [suffix, stat] of [...source.files].reverse()) {
      const path = join(legacyDirectory, source.name + suffix);
      const current = fileStat(path);
      if (!current || fileVersion(current) !== fileVersion(stat)) throw Error('Migration source changed');
      unlinkSync(path);
      if (suffix) syncPath(legacyDirectory);
    }
  }
  if (directoryStat(legacyDirectory)) {
    syncPath(legacyDirectory);
    if (readdirSync(legacyDirectory).length === 0) {
      rmdirSync(legacyDirectory);
      syncPath(dirname(legacyDirectory));
    }
  }

  unlinkSync(manifestPath);
  syncPath(stage);
  unlinkSync(snapshot);
  rmdirSync(stage);
  syncPath(parent);
  return true;
}
