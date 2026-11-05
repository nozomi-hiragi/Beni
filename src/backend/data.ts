import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateId, validProjectId, validTaskId } from '../shared/ids';
export type Metadata = {
  version: 1;
  id: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
};
export type TaskMetadata = Metadata & {
  documentBaseline?: Record<string, {hash: string; modifiedAt: number}>;
  phase: string;
  status: string;
};
export function pathExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
export function directory(path: string) {
  if (!pathExists(path)) mkdirSync(path, {
    mode: 0o700
  });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid managed directory');
  return path;
}
export function projectRoot(folder: string) {
  const root = resolve(folder);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid project directory');
  return directory(join(root, '.beni'));
}
export function readJson(path: string): any {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid metadata file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function writeJson(path: string, value: unknown) {
  if (pathExists(path)) readJson(path);
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, {
      force: true
    });
  }
}
function validDate(value: unknown) {
  return value === null || typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function metadata(path: string, kind: 'project' | 'task'): Metadata | TaskMetadata {
  const value = readJson(path);
  if (value.version !== 1) throw Error('Unsupported metadata version');
  if (!(kind === 'project' ? validProjectId(value.id) : validTaskId(value.id)) || typeof value.name !== 'string' || !value.name.trim() || !validDate(value.createdAt) || !validDate(value.updatedAt) || kind === 'task' && (typeof value.phase !== 'string' || !value.phase || typeof value.status !== 'string' || !value.status)) throw Error('Invalid metadata');
  return value;
}
export function newMetadata(kind: 'project' | 'task', name: string, unknownDates = false): Metadata {
  const now = unknownDates ? null : new Date().toISOString();
  return {
    version: 1,
    id: generateId(kind),
    name,
    createdAt: now,
    updatedAt: now
  };
}
export function recoverTasks(folder: string) {
  const root = directory(join(projectRoot(folder), 'tasks'));
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.creating-')) continue;
    const path = join(root, entry);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid task directory');
    const file = join(path, 'task.json');
    if (pathExists(file)) {
      const value = metadata(file, 'task');
      if (value.id !== entry) throw Error('Task directory ID mismatch');
      continue;
    }
    if (!validTaskId(entry) && !/^\d+$/.test(entry)) throw Error('Unrecognized task directory');
    const documents = readdirSync(path).filter(name => /^[a-z][a-z0-9-]*\.md$/.test(name));
    if (!documents.length) continue;
    for (const name of documents) {
      const stat = lstatSync(join(path, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid document file');
    }
    const value = {
      ...newMetadata('task', 'Unknown', true),
      phase: 'requirements',
      status: 'idle'
    };
    if (validTaskId(entry)) value.id = entry;else {
      const target = join(root, value.id);
      if (existsSync(target)) throw Error('Task ID collision');
      renameSync(path, target);
    }
    writeJson(join(root, value.id, 'task.json'), value);
  }
  return root;
}
