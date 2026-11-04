import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generateId, validProjectId, validTaskId } from '../shared/ids';
import { directory, metadata, newMetadata, projectRoot, pathExists, readJson, writeJson } from './data';
import { packHash, validId, validPack } from '../shared/communication';
const digest = (path: string) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid migration file');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
};
function copyTree(source: string, target: string) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw Error('Symlink in migration source');
  if (stat.isDirectory()) {
    directory(target);
    for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
  } else {
    if (!stat.isFile() || stat.nlink !== 1) throw Error('Invalid migration source');
    if (pathExists(target)) {
      if (digest(source) !== digest(target)) throw Error('Migration destination collision');
    } else copyFileSync(source, target);
    if (digest(source) !== digest(target)) throw Error('Copy verification failed');
  }
}
function equalJson(path: string, value: any) {
  if (pathExists(path)) {
    if (JSON.stringify(readJson(path)) !== JSON.stringify(value)) throw Error('Migration destination collision');
  } else writeJson(path, value);
}
export async function rewriteConversation(value: any, projectId: string, taskId: string | null, clone = false) {
  const nullableId = (id: unknown) => id === null || validId(id);
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const validMessage = (m: any) => m && validId(m.id) && validId(m.sendId) && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role) && m.provider === 'codex' && (m.model === null || typeof m.model === 'string') && date(m.createdAt) && date(m.updatedAt) && nullableId(m.threadId) && nullableId(m.sessionId) && ['pending', 'streaming', 'completed', 'failed', 'interrupted', 'unknown'].includes(m.status);
  if (!value || value.version !== 1 || !validId(value.id) || !nullableId(value.threadId) || !nullableId(value.sessionId) || !Array.isArray(value.messages) || !value.messages.every(validMessage) || new Set(value.messages.map((m: any) => m.id)).size !== value.messages.length) throw Error('Unsupported chat history');
  if (value.packs !== undefined && (!Array.isArray(value.packs) || value.packs.some((pack: any, index: number) => !validPack(pack) || pack.sequence !== index + 1 || !value.messages.some((m: any) => m.id === pack.messageId && m.sendId === pack.sendId && m.role === pack.role)) || new Set(value.packs.map((pack: any) => pack.packId)).size !== value.packs.length)) throw Error('Unsupported chat pack history');
  value.projectId = projectId;
  value.taskId = taskId;
  if (clone) {
    value.id = crypto.randomUUID();
    value.threadId = null;
    value.sessionId = null;
    for (const message of value.messages) {
      message.threadId = null;
      message.sessionId = null;
      if (message.status === 'pending' || message.status === 'streaming') message.status = 'unknown';
    }
  }
  for (const pack of value.packs ?? []) {
    if (clone && pack.state === 'streaming') {
      pack.state = 'closed';
      pack.status = pack.role === 'user' ? 'completed' : 'unknown';
    }
    if ('hash' in pack) pack.hash = await packHash(pack);
  }
  return value;
}
type Journal = {
  version: 1;
  complete: boolean;
  projects: Record<string, string>;
  tasks: Record<string, string>;
  outputs: Record<string, string>;
  source?: string;
  backedUp?: boolean;
};
// サーバー停止中のみ実行する。バックアップと対応表は削除しない。
export async function migrateData(dataDirectory: string) {
  const data = resolve(dataDirectory),
    dbPath = join(data, 'beni.sqlite'),
    migration = directory(join(data, 'migrations')),
    work = directory(join(migration, 'v1')),
    journalPath = join(work, 'journal.json');
  const db = new Database(dbPath);
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='tasks'").get()) return;
    const projects = db.query('SELECT * FROM projects ORDER BY id').all() as any[],
      tasks = db.query('SELECT * FROM tasks ORDER BY id').all() as any[];
    const messages = db.query('SELECT * FROM messages ORDER BY id').all() as any[],
      documents = db.query('SELECT * FROM documents ORDER BY id').all() as any[];
    const integerId = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
    if (projects.some(p => !integerId(p.id)) || tasks.some(t => !integerId(t.id) || !integerId(t.project_id)) || messages.some(m => !integerId(m.id) || !integerId(m.project_id) || m.task_id !== null && !integerId(m.task_id)) || documents.some(d => !integerId(d.id) || !integerId(d.task_id) || !integerId(d.version))) throw Error('Unsupported legacy integer identifier or document revision');
    if (tasks.some(t => !projects.some(p => p.id === t.project_id)) || documents.some(d => !tasks.some(t => t.id === d.task_id)) || messages.some(m => !projects.some(p => p.id === m.project_id) || m.task_id !== null && !tasks.some(t => t.id === m.task_id && t.project_id === m.project_id))) throw Error('Orphan legacy database reference; restore missing registrations before migrating');
    const journal: Journal = existsSync(journalPath) ? readJson(journalPath) : {
      version: 1,
      complete: false,
      projects: {},
      tasks: {},
      outputs: {}
    };
    if (!existsSync(journalPath)) {
      for (const project of projects) {
        journal.projects[project.id] = generateId('project');
      }
      for (const task of tasks) journal.tasks[task.id] = generateId('task');
      writeJson(journalPath, journal);
    }
    const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const validMap = (value: any, rows: any[], valid: (value: unknown) => boolean) => object(value) && Object.keys(value).length === rows.length && Object.entries(value).every(([key, id]) => /^[1-9][0-9]*$/.test(key) && rows.some(row => String(row.id) === key) && valid(id)) && new Set(Object.values(value)).size === rows.length;
    if (journal.version !== 1 || typeof journal.complete !== 'boolean' || !validMap(journal.projects, projects, validProjectId) || !validMap(journal.tasks, tasks, validTaskId) || !object(journal.outputs) || journal.source !== undefined && !/^[0-9a-f]{64}$/.test(journal.source) || Object.entries(journal.outputs).some(([path, hash]) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || !projects.some(project => {
      const root = join(resolve(project.folder), '.beni') + '/';
      return path.startsWith(root) && resolve(path) === path;
    }))) throw Error('Unsupported or invalid migration journal');
    const sourceFingerprint = createHash('sha256').update(JSON.stringify({
      projects,
      tasks,
      messages,
      documents
    })).digest('hex');
    if (journal.source && journal.source !== sourceFingerprint) throw Error('Legacy database changed since migration began');
    journal.source = sourceFingerprint;
    writeJson(journalPath, journal);
    const backup = directory(join(work, 'backup'));
    if (!existsSync(join(backup, 'beni.sqlite'))) {
      db.exec('PRAGMA wal_checkpoint(FULL)');
      db.exec(`VACUUM INTO '${join(backup, 'beni.sqlite').replaceAll("'", "''")}'`);
    }
    if (!journal.backedUp && existsSync(join(data, 'chat'))) copyTree(join(data, 'chat'), join(backup, 'chat'));
    for (const project of projects) {
      if (!existsSync(project.folder)) throw Error('Project folder missing; restore it before migrating');
      const root = projectRoot(project.folder);
      if (pathExists(join(root, 'project.json')) && readJson(join(root, 'project.json')).id !== journal.projects[project.id]) throw Error('Existing project metadata conflicts with legacy migration');
      const backupProject = join(backup, `project-${project.id}`);
      if (!journal.backedUp) copyTree(root, backupProject);
    }
    journal.backedUp = true;
    writeJson(journalPath, journal);
    // 記録済みの生成物を検証し、途中停止後の変更を上書きしない。
    for (const [path, hash] of Object.entries(journal.outputs)) if (!existsSync(path) || digest(path) !== hash) throw Error('Migration output changed; restore backup before retrying');
    const record = (path: string) => {
      journal.outputs[path] = digest(path);
      writeJson(journalPath, journal);
    };
    const matchedChats: string[] = [];
    const chatBackup = join(backup, 'chat');
    for (const project of projects) {
      const root = projectRoot(project.folder),
        pid = journal.projects[project.id]!;
      const projectFile = join(root, 'project.json');
      const pm = {
        ...newMetadata('project', project.name, true),
        id: pid
      };
      equalJson(projectFile, pm);
      record(projectFile);
      const taskRoot = directory(join(root, 'tasks')),
        chatRoot = directory(join(root, 'chat'));
      const owned = tasks.filter(t => t.project_id === project.id);
      for (const task of owned) {
        const id = journal.tasks[task.id]!,
          target = join(taskRoot, id),
          source = join(taskRoot, String(task.id));
        if (existsSync(source)) copyTree(source, target);else directory(target);
        const recordTree = (path: string) => {
          const stat = lstatSync(path);
          if (stat.isDirectory()) for (const name of readdirSync(path)) recordTree(join(path, name));else record(path);
        };
        recordTree(target);
        const tm = {
          ...newMetadata('task', task.name, true),
          id,
          phase: task.phase,
          status: task.status
        };
        equalJson(join(target, 'task.json'), tm);
        record(join(target, 'task.json'));
        for (const [kind, file] of [['requirements', 'requirements.md'], ['implementation-plan', 'implementation-plan.md']] as const) {
          const path = join(target, file);
          if (!existsSync(path)) {
            const latest = documents.filter(d => d.task_id === task.id && (d.kind === kind || kind === 'implementation-plan' && d.kind === 'plan')).at(-1);
            if (latest) {
              await Bun.write(path, latest.content);
              record(path);
            }
          }
        }
      }
      const archive = join(root, 'legacy-history.json');
      equalJson(archive, {
        version: 1,
        reason: 'Legacy rows do not encode reliable send/pack lifecycle; preserved without inventing execution outcomes.',
        project,
        taskIdMap: Object.fromEntries(owned.map(t => [t.id, journal.tasks[t.id]])),
        tasks: owned,
        messages: messages.filter(m => m.project_id === project.id),
        documents: documents.filter(d => owned.some(t => t.id === d.task_id))
      });
      record(archive);
      if (existsSync(chatBackup)) for (const filename of readdirSync(chatBackup)) {
        const match = filename.match(new RegExp(`^${project.id}-(general|[0-9]+)\\.json$`));
        if (!match) continue;
        const oldTask = match[1]!,
          tid = oldTask === 'general' ? null : journal.tasks[oldTask];
        if (oldTask !== 'general' && !owned.some(t => String(t.id) === oldTask)) throw Error('Orphan conversation requires matching task registration');
        const sourcePath = join(data, 'chat', filename),
          backupPath = join(chatBackup, filename);
        if (pathExists(sourcePath) && digest(sourcePath) !== digest(backupPath)) throw Error('Legacy chat changed since migration backup');
        matchedChats.push(filename);
        const original = readJson(backupPath);
        if (String(original.projectId) !== String(project.id) || (original.taskId === null ? 'general' : String(original.taskId)) !== oldTask) throw Error('Conversation scope mismatch');
        const value = await rewriteConversation(original, pid, tid ?? null);
        const target = join(chatRoot, tid === null || tid === undefined ? 'general.json' : `${tid}.json`);
        equalJson(target, value);
        record(target);
      }
    }
    for (const [path, hash] of Object.entries(journal.outputs)) if (digest(path) !== hash) throw Error('Migration verification failed');
    // 検証済みコピーだけを廃止する。削除失敗時もバックアップは残る。
    for (const p of projects) for (const task of tasks.filter(t => t.project_id === p.id)) {
      const source = join(p.folder, '.beni', 'tasks', String(task.id)),
        target = join(p.folder, '.beni', 'tasks', journal.tasks[task.id]!);
      if (existsSync(source)) {
        copyTree(source, target);
        rmSync(source, {
          recursive: true
        });
      }
    }
    for (const filename of matchedChats) {
      const source = join(data, 'chat', filename);
      if (pathExists(source)) {
        if (digest(source) !== digest(join(chatBackup, filename))) throw Error('Legacy chat changed since migration backup');
        rmSync(source);
      }
    }
    db.transaction(() => {
      db.exec('DROP TABLE documents; DROP TABLE messages; DROP TABLE tasks; ALTER TABLE projects RENAME TO legacy_projects; CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL UNIQUE)');
      for (const p of projects) db.query('INSERT INTO projects VALUES (?,?,?)').run(journal.projects[p.id]!, p.name, p.folder);
      db.exec('DROP TABLE legacy_projects');
    }).immediate();
    journal.complete = true;
    writeJson(journalPath, journal);
  } finally {
    db.close();
  }
}
export async function cloneProject(sourceFolder: string, destinationFolder: string) {
  const sourceDirectory = resolve(sourceFolder);
  const source = join(sourceDirectory, '.beni');
  for (const path of [sourceDirectory, source]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid clone source directory');
  }
  const destination = resolve(destinationFolder);
  if (destination === source || destination.startsWith(source + '/')) throw Error('Clone destination cannot be inside source data');
  if (pathExists(destination)) directory(destination);
  const canonicalSource = realpathSync(source);
  const canonicalDestination = pathExists(destination) ? realpathSync(destination) : join(realpathSync(dirname(destination)), basename(destination));
  if (canonicalDestination === canonicalSource || canonicalDestination.startsWith(canonicalSource + '/')) throw Error('Clone destination cannot be inside source data');
  directory(destination);
  const finalTarget = join(destination, '.beni');
  if (pathExists(finalTarget)) throw Error('Clone destination already contains .beni');
  const pm = metadata(join(source, 'project.json'), 'project'),
    pid = generateId('project'),
    map: Record<string, string> = {};
  const tasksRoot = join(source, 'tasks');
  if (existsSync(tasksRoot)) for (const id of readdirSync(tasksRoot)) {
    if (!validTaskId(id)) throw Error('Invalid task directory');
    if (metadata(join(tasksRoot, id, 'task.json'), 'task').id !== id) throw Error('Task directory ID mismatch');
    map[id] = generateId('task');
  }
  const target = mkdtempSync(join(destination, '.beni-cloning-'));
  try {
    copyTree(source, target);
    const now = new Date().toISOString();
    writeJson(join(target, 'project.json'), {
      ...pm,
      id: pid,
      createdAt: now,
      updatedAt: now
    });
    for (const [old, id] of Object.entries(map)) {
      const task = metadata(join(target, 'tasks', old, 'task.json'), 'task');
      renameSync(join(target, 'tasks', old), join(target, 'tasks', id));
      writeJson(join(target, 'tasks', id, 'task.json'), {
        ...task,
        id,
        createdAt: now,
        updatedAt: now
      });
    }
    const archive = join(target, 'legacy-history.json');
    if (pathExists(archive)) {
      const history = readJson(archive);
      if (history.taskIdMap) for (const key of Object.keys(history.taskIdMap)) history.taskIdMap[key] = map[history.taskIdMap[key]] ?? history.taskIdMap[key];
      writeJson(archive, history);
    }
    const chat = join(target, 'chat');
    if (existsSync(chat)) for (const filename of readdirSync(chat)) {
      if (!filename.endsWith('.json')) throw Error('Invalid chat file');
      const old = filename.slice(0, -5),
        tid = old === 'general' ? null : map[old];
      if (tid === undefined) throw Error('Unknown task chat');
      const original = readJson(join(chat, filename));
      if (original.projectId !== pm.id || original.taskId !== (old === 'general' ? null : old)) throw Error('Clone conversation scope mismatch');
      const value = await rewriteConversation(original, pid, tid, true);
      const output = join(chat, tid === null ? 'general.json' : `${tid}.json`);
      if (output !== join(chat, filename) && existsSync(output)) throw Error('Clone chat collision');
      writeJson(output, value);
      if (output !== join(chat, filename)) rmSync(join(chat, filename));
    }
    if (pathExists(finalTarget)) throw Error('Clone destination already contains .beni');
    renameSync(target, finalTarget);
    return {
      projectId: pid,
      tasks: map
    };
  } finally {
    rmSync(target, {
      recursive: true,
      force: true
    });
  }
}
