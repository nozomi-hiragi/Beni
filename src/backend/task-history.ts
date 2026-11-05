import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directory, pathExists, writeJson } from './data';
import { isTaskPhase, type TaskPhase } from '../shared/task-phase';

export type TaskEvent = {
  id: number;
  type: 'document.created' | 'document.updated' | 'document.deleted' | 'document.renamed' | 'phase.changed';
  at: string;
  sourcePhase: TaskPhase | null;
  path?: string;
  previousPath?: string;
  version?: string;
  previousVersion?: string;
  from?: TaskPhase;
  to?: TaskPhase;
};
type History = {version: 1; phase: TaskPhase; snapshot: Record<string, string>; events: TaskEvent[]};
const documentPath = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]*\.md$/.test(value);
const versionHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// 検証したファイルと開いたファイルが一致することを確認し、リンク経由の読み込みを拒否する。
function readRegular(path: string) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error('Invalid history file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) throw Error('Invalid history file');
    const content = readFileSync(fd), after = fstatSync(fd);
    if (after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Error('History file changed while reading');
    return content;
  } finally { closeSync(fd); }
}
function readVersion(versions: string, version: string) {
  const content = readRegular(join(versions, version + '.md'));
  if (hash(content) !== version) throw Error('History version hash mismatch');
  return content;
}
function readHistory(root: string): History | undefined {
  const file = join(root, 'index.json');
  if (!pathExists(file)) return undefined;
  // readJson と同じファイル種別の制約に加え、イベントの連番と再生結果も検証する。
  const value = JSON.parse(readRegular(file).toString('utf8'));
  if (!object(value) || value.version !== 1 || !isTaskPhase(value.phase) || !object(value.snapshot) || !Array.isArray(value.events)) throw Error('Invalid task history');
  const snapshot: Record<string, string> = {}, referenced = new Set<string>();
  let phase: TaskPhase | undefined;
  for (const [index, event] of value.events.entries()) {
    if (!object(event) || event.id !== index + 1 || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at || event.sourcePhase !== null && !isTaskPhase(event.sourcePhase)) throw Error('Invalid task event');
    const path = event.path, version = event.version;
    if (event.type === 'phase.changed') {
      if (!isTaskPhase(event.from) || !isTaskPhase(event.to) || event.from === event.to || phase !== undefined && phase !== event.from) throw Error('Invalid phase event');
      phase = event.to;
    } else {
      if (!documentPath(path) || !versionHash(version)) throw Error('Invalid document event');
      referenced.add(version);
      if (event.type === 'document.created') {
        if (snapshot[path] !== undefined) throw Error('Invalid document creation');
        snapshot[path] = version;
      } else if (event.type === 'document.updated') {
        if (!versionHash(event.previousVersion) || snapshot[path] !== event.previousVersion || version === event.previousVersion) throw Error('Invalid document update');
        referenced.add(event.previousVersion);
        snapshot[path] = version;
      } else if (event.type === 'document.deleted') {
        if (snapshot[path] !== version) throw Error('Invalid document deletion');
        delete snapshot[path];
      } else if (event.type === 'document.renamed') {
        if (!documentPath(event.previousPath) || snapshot[event.previousPath] !== version || snapshot[path] !== undefined) throw Error('Invalid document rename');
        delete snapshot[event.previousPath];
        snapshot[path] = version;
      } else throw Error('Invalid task event type');
    }
  }
  if (phase !== undefined && phase !== value.phase || Object.entries(value.snapshot).some(([path, version]) => !documentPath(path) || !versionHash(version)) || JSON.stringify(Object.entries(snapshot).sort()) !== JSON.stringify(Object.entries(value.snapshot).sort())) throw Error('History snapshot mismatch');
  const versions = directory(join(root, 'versions'));
  for (const version of referenced) readVersion(versions, version);
  return value as History;
}

export function captureTaskHistory(task: string, phase: string, sourcePhase: TaskPhase | null = null) {
  if (!isTaskPhase(phase) || sourcePhase !== null && !isTaskPhase(sourcePhase)) throw Error('Invalid history phase');
  directory(task);
  const root = directory(join(task, '.history')), versions = directory(join(root, 'versions'));
  const previous = readHistory(root);
  const value: History = previous ?? {version: 1, phase, snapshot: {}, events: []};
  const current: Record<string, string> = {};
  // 本文を先に保存する。index確定前の中断で残った版は未参照のまま保持できる。
  for (const path of readdirSync(task).filter(documentPath).sort()) {
    const content = readRegular(join(task, path)), version = hash(content), target = join(versions, version + '.md');
    current[path] = version;
    if (pathExists(target)) readVersion(versions, version);
    else {
      const temporary = join(versions, `.tmp-${crypto.randomUUID()}`);
      try {
        writeFileSync(temporary, content, {flag: 'wx', mode: 0o600});
        // 完成済み本文だけを公開する。既存の版を上書きしない。
        if (pathExists(target)) readVersion(versions, version);
        else renameSync(temporary, target);
      } finally { rmSync(temporary, {force: true}); }
      readVersion(versions, version);
    }
  }
  const at = new Date().toISOString();
  const append = (event: Omit<TaskEvent, 'id' | 'at' | 'sourcePhase'>) => value.events.push({...event, id: value.events.length + 1, at, sourcePhase});
  const removed = Object.keys(value.snapshot).filter(path => !(path in current));
  const added = Object.keys(current).filter(path => !(path in value.snapshot));
  const renamed = new Set<string>();
  for (const path of removed) {
    const version = value.snapshot[path]!;
    const candidates = added.filter(next => current[next] === version);
    if (candidates.length === 1 && removed.filter(old => value.snapshot[old] === version).length === 1) {
      append({type: 'document.renamed', previousPath: path, path: candidates[0]!, version});
      renamed.add(candidates[0]!);
    } else append({type: 'document.deleted', path, version});
  }
  for (const path of added) if (!renamed.has(path)) append({type: 'document.created', path, version: current[path]!});
  for (const path of Object.keys(current)) if (path in value.snapshot && current[path] !== value.snapshot[path]) append({type: 'document.updated', path, version: current[path]!, previousVersion: value.snapshot[path]!});
  if (value.phase !== phase) append({type: 'phase.changed', from: value.phase, to: phase});
  const changed = !previous || value.phase !== phase || JSON.stringify(value.snapshot) !== JSON.stringify(current);
  value.phase = phase;
  value.snapshot = current;
  if (changed) writeJson(join(root, 'index.json'), value);
  return value;
}
export function taskEvents(task: string, phase: string, after = 0, through?: number, limit = 100) {
  if (!Number.isSafeInteger(after) || after < 0 || through !== undefined && (!Number.isSafeInteger(through) || through < 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || through !== undefined && through < after) throw Error('Invalid event cursor');
  const history = captureTaskHistory(task, phase), tail = history.events.length;
  if (after > tail || through !== undefined && through > tail) throw Error('Unknown event cursor');
  const upper = through ?? tail, events = history.events.slice(after, Math.min(upper, after + limit));
  const lastEventId = events.at(-1)?.id ?? after;
  return {events, lastEventId, through: upper, hasMore: lastEventId < upper};
}
export function taskEventVersion(task: string, version: string) {
  if (!versionHash(version)) throw Error('Invalid history version');
  const root = directory(join(directory(task), '.history')), history = readHistory(root);
  if (!history || !history.events.some(event => event.version === version || event.previousVersion === version)) throw Error('Unknown history version');
  return {version, content: readVersion(directory(join(root, 'versions')), version).toString('utf8')};
}
