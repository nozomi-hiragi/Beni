import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenProjectDatabase, projectDatabaseMigrationStage } from './flat-project-migration';

const projectId = '01234567-89ab-7000-8123-0123456789ab';
const otherId = '01234567-89ab-7000-8123-0123456789ac';
let root: string, legacy: string, source: string, destination: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'beni-flat-'));
  legacy = join(root, projectId);
  source = join(legacy, 'project.sqlite');
  destination = join(root, projectId + '.sqlite');
  mkdirSync(legacy);
});
afterEach(() => rmSync(root, {recursive: true, force: true}));

function makeDatabase(path: string, id = projectId) {
  const db = new Database(path);
  db.exec(`CREATE TABLE project_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), project_id TEXT NOT NULL);
    CREATE TABLE extra (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
    CREATE INDEX extra_value ON extra(value);
    CREATE VIEW extra_rows AS SELECT value FROM extra;
    CREATE TRIGGER extra_uppercase AFTER INSERT ON extra BEGIN UPDATE extra SET value=upper(value) WHERE id=new.id; END;
    INSERT INTO extra(value) VALUES ('first');`);
  db.query('INSERT INTO project_identity VALUES (1,?)').run(id);
  return db;
}

function inspect<T>(path: string, query: string) {
  const db = new Database(path, {readonly: true, create: false});
  try { return db.query<T, []>(query).all(); } finally { db.close(); }
}

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const relocate = () => flattenProjectDatabase(legacy, destination, projectId);

test('recovers committed WAL frames and preserves schema, sequence, and unrelated files', () => {
  const working = join(root, 'working.sqlite');
  const db = makeDatabase(working);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO extra(value) VALUES ('last');");
    copyFileSync(working, source);
    copyFileSync(working + '-wal', source + '-wal');
    copyFileSync(working + '-shm', source + '-shm');
  } finally { db.close(); }
  writeFileSync(join(legacy, 'keep.txt'), 'keep');
  expect(inspect(source, 'SELECT value FROM extra_rows')).toEqual([{value: 'FIRST'}, {value: 'LAST'}]);

  expect(relocate()).toBe(true);
  expect(inspect(destination, 'SELECT value FROM extra_rows')).toEqual([{value: 'FIRST'}, {value: 'LAST'}]);
  expect(inspect(destination, "SELECT type,name FROM sqlite_schema WHERE name LIKE 'extra_%' ORDER BY type"))
    .toEqual([{type: 'index', name: 'extra_value'}, {type: 'trigger', name: 'extra_uppercase'}, {type: 'view', name: 'extra_rows'}]);
  expect(inspect(destination, "SELECT seq FROM sqlite_sequence WHERE name='extra'")).toEqual([{seq: 2}]);
  expect(readdirSync(legacy)).toEqual(['keep.txt']);
  expect(lstatSync(destination).nlink).toBe(1);
  expect(relocate()).toBe(false);
});

test('rolls back a hot journal on the copy and prunes the empty directory', () => {
  const db = makeDatabase(source);
  db.close();
  const committed = readFileSync(source);
  const update = new Database(source);
  update.exec("UPDATE extra SET value='DIRTY'");
  update.close();
  const dirty = readFileSync(source);
  const pageSize = committed.readUInt16BE(16) || 65536;
  expect(dirty.length).toBe(committed.length);

  // SQLite のロールバックジャーナルの形式で、ディスクに流出したページの元データを作る。
  const header = Buffer.alloc(512), records: Buffer[] = [];
  const nonce = 0x12345678;
  Buffer.from('d9d505f920a163d7', 'hex').copy(header);
  for (let offset = 0; offset < committed.length; offset += pageSize) {
    const before = committed.subarray(offset, offset + pageSize);
    if (before.equals(dirty.subarray(offset, offset + pageSize))) continue;
    const record = Buffer.alloc(pageSize + 8);
    record.writeUInt32BE(offset / pageSize + 1, 0);
    before.copy(record, 4);
    let checksum = nonce;
    for (let index = pageSize - 200; index >= 0; index -= 200) checksum += before[index]!;
    record.writeUInt32BE(checksum >>> 0, pageSize + 4);
    records.push(record);
  }
  expect(records.length).toBeGreaterThan(0);
  header.writeUInt32BE(records.length, 8);
  header.writeUInt32BE(nonce, 12);
  header.writeUInt32BE(committed.length / pageSize, 16);
  header.writeUInt32BE(header.length, 20);
  header.writeUInt32BE(pageSize, 24);
  writeFileSync(source + '-journal', Buffer.concat([header, ...records]));

  expect(relocate()).toBe(true);
  expect(inspect(destination, 'SELECT value FROM extra')).toEqual([{value: 'FIRST'}]);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(destination + '-journal')).toBe(false);
});

test('preserves the committed state when an invalidated rollback journal remains', () => {
  const db = makeDatabase(source);
  db.exec("PRAGMA journal_mode=PERSIST; UPDATE extra SET value='KEPT'");
  db.close();
  expect(existsSync(source + '-journal')).toBe(true);
  expect(relocate()).toBe(true);
  expect(inspect(destination, 'SELECT value FROM extra')).toEqual([{value: 'KEPT'}]);
  expect(existsSync(destination + '-journal')).toBe(false);
});

test('checks identity before publishing and requires metadata for a legacy events database without identity', () => {
  source = join(legacy, 'events.sqlite');
  const db = new Database(source);
  db.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('kept')");
  db.close();
  const metadataPath = join(legacy, 'project.json');
  expect(relocate).toThrow('identity is missing or mismatched');
  expect(existsSync(destination)).toBe(false);
  writeFileSync(metadataPath, JSON.stringify({version: 1, id: otherId, name: 'Fixture', createdAt: null, updatedAt: null}));
  expect(relocate).toThrow('identity is missing or mismatched');
  writeFileSync(metadataPath, JSON.stringify({version: 1, id: projectId, name: 'Fixture', createdAt: null, updatedAt: null}));
  expect(relocate()).toBe(true);
  expect(inspect(destination, 'SELECT value FROM preserved')).toEqual([{value: 'kept'}]);
  expect(inspect(destination, 'SELECT project_id FROM project_identity')).toEqual([{project_id: projectId}]);
  expect(readdirSync(legacy)).toEqual(['project.json']);
});

test('rejects database identity mismatch, even with matching metadata', () => {
  makeDatabase(source, otherId).close();
  writeFileSync(join(legacy, 'project.json'), JSON.stringify({version: 1, id: projectId, name: 'Fixture', createdAt: null, updatedAt: null}));
  const before = digest(source);
  expect(relocate).toThrow('Project ID mismatch');
  expect(digest(source)).toBe(before);
  expect(existsSync(destination)).toBe(false);
});

test('rejects a destination collision even when the databases are byte-identical', () => {
  makeDatabase(source).close();
  copyFileSync(source, destination);
  const before = digest(source);
  expect(relocate).toThrow('destination already exists');
  expect(digest(source)).toBe(before);
  expect(digest(destination)).toBe(before);
});

test('rejects linked and orphaned sidecars and ambiguous legacy databases', () => {
  const journal = source + '-journal', extra = join(root, 'outside');
  writeFileSync(extra, 'safe');
  symlinkSync(extra, journal);
  expect(relocate).toThrow('Invalid migration file');
  unlinkSync(journal);
  linkSync(extra, journal);
  expect(relocate).toThrow('Invalid migration file');
  unlinkSync(journal);
  writeFileSync(journal, '');
  expect(relocate).toThrow('Orphaned SQLite sidecar');
  unlinkSync(journal);
  makeDatabase(source).close();
  copyFileSync(source, join(legacy, 'events.sqlite'));
  expect(relocate).toThrow('Both legacy project databases exist');
  expect(readFileSync(extra, 'utf8')).toBe('safe');
  expect(existsSync(destination)).toBe(false);
});

test('rejects super-journal references without opening the staged database', () => {
  makeDatabase(source).close();
  const trailer = Buffer.alloc(16);
  trailer.writeUInt32BE(7, 0);
  Buffer.from('d9d505f920a163d7', 'hex').copy(trailer, 8);
  writeFileSync(source + '-journal', Buffer.concat([Buffer.from('fixture'), trailer]));
  expect(relocate).toThrow('SQLite super-journal is unsupported');
  expect(existsSync(source + '-journal')).toBe(true);
  expect(existsSync(destination)).toBe(false);
});

test('resumes published migration after a sidecar was removed during cleanup', () => {
  makeDatabase(source).close();
  const stage = projectDatabaseMigrationStage(destination);
  mkdirSync(stage);
  const snapshot = join(stage, 'database.sqlite'), manifest = join(stage, 'manifest.json');
  copyFileSync(source, snapshot);
  linkSync(snapshot, destination);
  const file = lstatSync(source), directory = lstatSync(legacy);
  const record = {
    version: 1,
    projectId,
    sourceDirectory: `${directory.dev}:${directory.ino}`,
    sourceDatabase: 'project.sqlite',
    sources: {
      '': `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}:${digest(source)}`,
      '-wal': 'removed:' + '0'.repeat(64),
    },
    destinationDigest: digest(snapshot),
  };
  writeFileSync(manifest, JSON.stringify({...record, sources: {...record.sources, '': 'changed:' + '0'.repeat(64)}}));
  expect(relocate).toThrow('Migration source changed');
  expect(existsSync(source)).toBe(true);
  writeFileSync(manifest, JSON.stringify(record));
  expect(relocate()).toBe(true);
  expect(existsSync(stage)).toBe(false);
  expect(existsSync(legacy)).toBe(false);
  expect(inspect(destination, 'SELECT value FROM extra')).toEqual([{value: 'FIRST'}]);
  expect(relocate()).toBe(false);
});

test('removes an empty stage left after the last snapshot link was removed', () => {
  makeDatabase(destination).close();
  mkdirSync(projectDatabaseMigrationStage(destination));
  expect(relocate()).toBe(true);
  expect(existsSync(projectDatabaseMigrationStage(destination))).toBe(false);
  expect(inspect(destination, 'SELECT value FROM extra')).toEqual([{value: 'FIRST'}]);
  expect(relocate()).toBe(false);
});
