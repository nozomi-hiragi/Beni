import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  readdirSync, rmdirSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { INSTRUCTIONS_CHAT_ID, object, validPack } from '../shared/communication';
import { generateId, validChatId, validProjectId, validTaskId } from '../shared/ids';
import { isTaskPhase, type TaskPhase } from '../shared/task-phase';
import { chatFileStem, chatIdPattern, workflowJobHash } from './chat-files';
import { decodeChatHistory } from './chat-history';
import { chatScopeKey, type ChatScope, type ChatStore } from './chat-store';
import { taskCompletedInstructionKey } from './instructions';

type Project = {projectId: string; directory: string; databasePath?: string; legacyDirectory?: string};
type Root = {projectId: string; directory: string; databasePath?: string};
type Candidate = {path: string; scope: ChatScope; archived: boolean; archiveId?: string};
type Source = Candidate & {raw: Record<string, unknown>; legacyId: string; digest: string; identity: string; links: number};
type RecordRow = {
  path: string; scope_key: string; legacy_id: string; chat_id: string; digest: string; identity: string;
  target_digest: string; archived: number; state: 'planned' | 'verified' | 'removed';
};
type Job = {id: string; project_id: string; task_id: string; event_key: string};
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`;
const unchanged = (before: Stats, after: Stats) => identity(before) === identity(after) &&
  before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
const table = (db: Database, name: string) =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function entries(path: string) {
  const info = stat(path);
  if (!info) return [];
  if (!info.isDirectory()) throw Error('Invalid legacy chat directory');
  return readdirSync(path).sort();
}

function parseJson(content: string): unknown {
  try { return JSON.parse(content); }
  catch { throw Error('Invalid chat migration JSON'); }
}

function readFile(path: string, before: Stats) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !unchanged(before, opened)) throw Error('Chat file changed during migration');
    const content = readFileSync(fd);
    if (!unchanged(opened, fstatSync(fd))) throw Error('Chat file changed during migration');
    return content;
  } finally { closeSync(fd); }
}

function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function stagedTasks(root: Root) {
  const {projectId, directory} = root;
  return entries(directory).flatMap(name => {
    const taskId = name.slice(10);
    if (!name.startsWith('.deleting-') || !validTaskId(taskId)) return [];
    const staged = join(directory, name), contents = entries(staged);
    if (!contents.includes('task') && !contents.includes('chat')) return [];
    let committed = contents.includes('committed.json');
    const journal = join(staged, committed ? 'committed.json' : 'journal.json');
    const info = lstatSync(journal), data = parseJson(readFile(journal, info).toString());
    if (!object(data) || info.nlink !== 1 || !(data.version === 1 || data.version === 2 && !committed) || data.projectId !== projectId || data.taskId !== taskId) {
      throw Error('Invalid legacy task deletion journal');
    }
    if (data.version === 2) committed = !databaseTaskOwners(root).has(taskId);
    return [{taskId, task: join(staged, 'task'), chat: join(staged, 'chat'), committed}];
  });
}

function projectRoots(projects: readonly Project[]) {
  const roots = new Map<string, Root>();
  for (const {projectId, directory, databasePath, legacyDirectory} of projects) {
    if (!validProjectId(projectId)) throw Error('Invalid legacy chat project');
    for (const path of [directory, legacyDirectory]) {
      if (!path) continue;
      const root = resolve(path), previous = roots.get(root);
      if (previous && previous.projectId !== projectId) throw Error('Conflicting legacy chat project');
      roots.set(root, {projectId, directory: root, ...(path === directory && databasePath ? {databasePath: resolve(databasePath)} : {})});
    }
  }
  return [...roots.values()];
}

function databaseTaskOwners(root: Root) {
  const owners = new Set<string>();
  for (const {path} of projectDatabases([root])) {
    const db = new Database(path, {readonly: true, create: false, strict: true});
    try {
      if (table(db, 'tasks')) for (const {id} of db.query<{id: string}, []>('SELECT id FROM tasks').iterate()) owners.add(id);
    } finally { db.close(); }
  }
  return owners;
}

function inventory(db: Database, dataDirectory: string, roots: Root[]) {
  const candidates: Candidate[] = [], cleanup = new Set<string>();
  entries(dataDirectory);
  function named(folder: string, matches: (name: string) => boolean, scope: ChatScope, archived = false) {
    for (const name of entries(folder)) {
      const stem = chatFileStem(name);
      if (matches(stem)) candidates.push({path: join(folder, name), scope, archived, ...(archived ? {archiveId: stem} : {})});
    }
    if (archived) cleanup.add(folder);
  }

  const instructions = join(dataDirectory, 'chat'), instructionScope = {projectId: INSTRUCTIONS_CHAT_ID, taskId: null, phase: null};
  named(instructions, name => name === 'instructions', instructionScope);
  const instructionArchives = roots.some(root => root.directory === dataDirectory) ? ['instruction-history'] : ['history', 'instruction-history'];
  for (const name of instructionArchives) named(join(instructions, name), id => chatIdPattern.test(id), instructionScope, true);
  cleanup.add(instructions);
  const jobs = table(db, 'instruction_jobs')
    ? db.query<Job, []>('SELECT id,project_id,task_id,event_key FROM instruction_jobs').all()
    : [];
  const jobsById = new Map(jobs.map(job => [job.id, job]));
  const jobsByHash = new Map(jobs.map(job => [workflowJobHash(job.id), job]));

  for (const root of roots) {
    const {projectId, directory} = root;
    entries(dirname(directory));
    const chat = join(directory, 'chat'), tasks = join(directory, 'tasks');
    const general = {projectId, taskId: null, phase: null};
    for (const folder of [directory, chat]) {
      named(folder, name => name === 'general', general);
      named(join(folder, 'history'), id => chatIdPattern.test(id), general, true);
    }
    cleanup.add(chat);
    const taskFolders = new Map<string, string>();
    for (const taskId of entries(tasks).filter(validTaskId)) taskFolders.set(taskId, join(tasks, taskId));
    const staged = stagedTasks(root);
    for (const {taskId, task, committed} of staged) {
      if (committed || !stat(task)) continue;
      if (taskFolders.has(taskId)) throw Error('Conflicting legacy task owner');
      taskFolders.set(taskId, task);
    }
    function workflow(folder: string, taskId: string | null, event?: string) {
      for (const name of entries(folder)) {
        const stem = chatFileStem(name);
        const direct = event && jobsById.get(stem);
        const hashed = jobsByHash.get(stem);
        if (!direct && !hashed) continue;
        let job = direct || hashed!;
        if (direct && hashed && direct.id !== hashed.id) {
          const path = join(folder, name);
          const raw: unknown = parseJson(readFile(path, lstatSync(path)).toString());
          if (!object(raw)) throw Error('Invalid legacy workflow chat');
          if (raw.workflowJobId === hashed.id) job = hashed;
        }
        if (job.project_id !== projectId || event && job.event_key !== event || taskId !== null && job.task_id !== taskId) throw Error('Invalid legacy workflow chat owner');
        candidates.push({path: join(folder, name), scope: {...general, workflowJobId: job.id}, archived: false});
      }
      cleanup.add(folder);
    }
    let databaseOwners: Set<string> | undefined;
    function taskChats(task: string, taskId: string) {
      const before = candidates.length;
      for (const name of entries(task)) {
        const phase = chatFileStem(name);
        if (isTaskPhase(phase)) candidates.push({path: join(task, name), scope: {projectId, taskId, phase}, archived: false});
      }
      named(join(task, 'history'), id => chatIdPattern.test(id), {projectId, taskId, phase: null}, true);
      workflow(join(task, 'workflow-jobs'), taskId);
      if (candidates.length !== before) {
        const owner = taskFolders.get(taskId);
        if (!owner) {
          if (!(databaseOwners ??= databaseTaskOwners(root)).has(taskId)) throw Error('Missing legacy chat task owner');
          return;
        }
        const path = join(owner, 'task.json'), info = stat(path);
        if (info) {
          const metadata = parseJson(readFile(path, info).toString());
          if (!object(metadata) || metadata.id !== taskId || info.nlink !== 1) throw Error('Invalid legacy chat task owner');
        }
      }
    }
    for (const [taskId, task] of taskFolders) taskChats(task, taskId);
    for (const taskId of entries(chat).filter(validTaskId)) {
      const task = join(chat, taskId);
      taskChats(task, taskId);
      cleanup.add(task);
    }
    for (const {taskId, task, chat, committed} of staged) {
      if (committed) {
        for (const folder of [task, chat]) {
          entries(folder);
          workflow(join(folder, 'workflow-jobs'), taskId);
        }
      } else {
        taskChats(chat, taskId);
        cleanup.add(chat);
      }
    }
    for (const folder of [directory, chat]) workflow(join(folder, 'workflow-jobs'), null);
    const workflows = join(directory, 'workflows');
    entries(workflows);
    workflow(join(workflows, taskCompletedInstructionKey), null, taskCompletedInstructionKey);
    cleanup.add(workflows);
  }
  return {candidates, cleanup};
}

function readSource(candidate: Candidate): Source {
  const info = lstatSync(candidate.path);
  if (!info.isFile()) throw Error('Invalid legacy chat file');
  const content = readFile(candidate.path, info);
  const raw: unknown = parseJson(content.toString());
  if (!object(raw) || raw.id !== undefined && raw.chatId !== undefined && raw.id !== raw.chatId) throw Error('Invalid legacy chat ID');
  const legacyId = raw.chatId ?? raw.id;
  const chat = decodeChatHistory({...raw, id: legacyId, chatId: legacyId});
  const {scope, archiveId} = candidate;
  if (archiveId !== undefined && archiveId !== chat.id || scope.projectId !== chat.projectId ||
      scope.taskId !== chat.taskId || scope.workflowJobId !== chat.workflowJobId ||
      (scope.taskId !== null && candidate.archived ? !isTaskPhase(chat.phase) : scope.phase !== chat.phase) ||
      chat.packs.some((pack, index) => !validPack(pack) || pack.sequence !== index + 1) ||
      new Set(chat.packs.map(pack => pack.packId)).size !== chat.packs.length) throw Error('Invalid legacy chat scope');
  return {...candidate, raw, scope: {...scope, phase: chat.phase}, legacyId: chat.id, digest: hash(content), identity: identity(info), links: info.nlink};
}

function targetContent(source: Source, id: string) {
  const {id: _, chatId: __, ...contents} = source.raw;
  return JSON.stringify({...contents, chatId: id}, null, 2) + '\n';
}

function createSchema(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_migration_sources (
    path TEXT PRIMARY KEY, scope_key TEXT NOT NULL, legacy_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    digest TEXT NOT NULL, identity TEXT NOT NULL, target_digest TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK(archived IN (0,1)), state TEXT NOT NULL CHECK(state IN ('planned','verified','removed'))
  );
  CREATE TABLE IF NOT EXISTS chat_migration_aliases (
    scope_key TEXT NOT NULL, legacy_id TEXT NOT NULL, chat_id TEXT NOT NULL, PRIMARY KEY(scope_key,legacy_id)
  );`);
}

function records(db: Database) {
  return db.query<RecordRow, []>("SELECT * FROM chat_migration_sources WHERE state<>'removed' ORDER BY path").all();
}

export function assertChatMigrationReady(chats: ChatStore, dataDirectory: string, projects: readonly Project[]) {
  if (table(chats.db, 'chat_migration_sources') && records(chats.db).length ||
      inventory(chats.db, resolve(dataDirectory), projectRoots(projects)).candidates.length) {
    throw Error('旧チャットの移行が必要です。Beni を停止し、bun src/backend/migrate-chats.ts を実行してください。');
  }
}

function scopeFromKey(key: string): ChatScope {
  const [projectId, taskId, phase, jobId] = JSON.parse(key) as [string, string | null, TaskPhase | null, string | null];
  const scope = {projectId, taskId, phase, ...(jobId === null ? {} : {workflowJobId: jobId})};
  if (chatScopeKey(scope) !== key) throw Error('Invalid chat migration scope');
  return scope;
}

function verifiedTarget(chats: ChatStore, row: RecordRow) {
  const path = chats.path(row.chat_id);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1) throw Error('Invalid chat migration target');
  const content = readFile(path, info);
  if (hash(content) !== row.target_digest) throw Error('Conflicting chat migration target');
  return chats.validate(parseJson(content.toString()), scopeFromKey(row.scope_key), row.chat_id);
}

function installTarget(chats: ChatStore, row: RecordRow, source: Source) {
  const path = chats.path(row.chat_id), temp = path + '.migration';
  const previous = stat(temp);
  const target = stat(path);
  // リンク作成後の中断なら、検証して作業名だけを取り除く。
  if (previous && target) {
    if (!previous.isFile() || !target.isFile() || identity(previous) !== identity(target) || target.nlink !== 2 ||
        hash(readFile(path, target)) !== row.target_digest) throw Error('Conflicting chat migration target');
    unlinkSync(temp);
  }
  if (!target) {
    if (previous) {
      if (!previous.isFile() || previous.nlink !== 1) throw Error('Invalid chat migration temporary file');
      unlinkSync(temp);
    }
    const content = targetContent(source, row.chat_id);
    if (hash(content) !== row.target_digest) throw Error('Chat source changed during migration');
    chats.validate(parseJson(content), source.scope, row.chat_id);
    writeFileSync(temp, content, {flag: 'wx', mode: 0o600, flush: true});
    linkSync(temp, path);
    unlinkSync(temp);
  }
  verifiedTarget(chats, row);
  syncDirectory(dirname(path));
}

function sameSource(row: RecordRow, source: Source | undefined): source is Source {
  return !!source && source.digest === row.digest && source.identity === row.identity &&
    source.legacyId === row.legacy_id && chatScopeKey(source.scope) === row.scope_key;
}

function prepare(chats: ChatStore, sources: Source[]) {
  const db = chats.db;
  const rows = new Map(db.query<RecordRow, []>('SELECT * FROM chat_migration_sources').all().map(row => [row.path, row]));
  const groups = new Map<string, Source[]>(), links = new Map<string, Source[]>();
  for (const source of sources) {
    const row = rows.get(source.path);
    if (row?.state === 'removed' || row && !sameSource(row, source)) throw Error('Chat source changed during migration');
    const scope = chatScopeKey(source.scope), key = JSON.stringify([scope, source.legacyId]);
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
    const aliases = links.get(source.identity) ?? [];
    aliases.push(source);
    links.set(source.identity, aliases);
  }
  for (const group of links.values()) {
    if (group.some(source => source.links !== group.length)) throw Error('Unexpected link to legacy chat');
  }
  const newRows = db.query(`INSERT INTO chat_migration_sources
    (path,scope_key,legacy_id,chat_id,digest,identity,target_digest,archived,state) VALUES (?,?,?,?,?,?,?,?,'planned')`);
  const occupied = new Set(db.query<{chat_id: string}, []>('SELECT chat_id FROM chat_migration_sources').all().map(row => row.chat_id));
  for (const group of groups.values()) {
    const first = group[0]!, archived = group.every(source => source.archived);
    const old = group.map(source => rows.get(source.path)).find(row => row !== undefined);
    const scope = chatScopeKey(first.scope);
    const id = old?.chat_id ?? (validChatId(first.legacyId) ? first.legacyId : generateId('chat'));
    const content = targetContent(first, id), digest = hash(content);
    // 旧アーカイブ操作の途中で作られた複製は、所有者と会話全体が同じ場合に限ってまとめる。
    if (group.some(source => targetContent(source, id) !== content)) throw Error('Conflicting legacy chat ID within its owner');
    if (!old) {
      const target = chats.path(id);
      if (occupied.has(id) || chats.ref(id) || stat(target) || stat(target + '.migration')) throw Error('Conflicting chat migration ID');
      if (!archived && chats.current(first.scope)) throw Error('Conflicting current chat owner');
      occupied.add(id);
    }
    for (const source of group) {
      const previous = rows.get(source.path);
      if (previous) {
        if (previous.chat_id !== id || previous.target_digest !== digest) throw Error('Conflicting chat migration record');
        continue;
      }
      if (old) throw Error('Unexpected legacy chat after migration began');
      newRows.run(source.path, scope, source.legacyId, id, source.digest, source.identity, digest, Number(archived));
    }
  }
  if (db.query(`SELECT scope_key FROM chat_migration_sources WHERE state='planned' AND archived=0
    GROUP BY scope_key HAVING count(DISTINCT chat_id)>1`).get()) throw Error('Conflicting legacy current chat owner');
}

function projectDatabases(roots: Root[]) {
  return roots.flatMap(root => {
    const paths = ['project.sqlite', 'events.sqlite'].map(name => join(root.directory, name));
    if (root.databasePath) paths.push(root.databasePath);
    const existing = paths.filter(path => stat(path));
    if (existing.length > 1) throw Error('Conflicting legacy project databases');
    for (const path of paths) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const info = stat(path + suffix);
        if (info && (!info.isFile() || info.nlink !== 1 || !existing.includes(path))) throw Error('Invalid legacy project database');
      }
    }
    return existing.map(path => ({...root, path}));
  });
}

function verifyProjectReferences(chats: ChatStore, roots: Root[], update: boolean) {
  for (const root of projectDatabases(roots)) {
    const {projectId, directory, path} = root;
    const db = new Database(path, {readonly: !update, create: false, strict: true});
    try {
      const tasks = entries(join(directory, 'tasks')).filter(validTaskId);
      const owners = new Set(tasks);
      if (table(db, 'tasks')) for (const {id} of db.query<{id: string}, []>('SELECT id FROM tasks').iterate()) owners.add(id);
      for (const {taskId, committed} of stagedTasks(root)) {
        if (!committed) owners.add(taskId);
      }
      const exists = (taskId: string | null) => taskId === null || owners.has(taskId);
      const cache = new Map<string, ReturnType<ChatStore['read']>>();
      const read = (taskId: string | null, phase: TaskPhase | null, id: string) => {
        const scope = {projectId, taskId, phase};
        const key = JSON.stringify([chatScopeKey(scope), id]);
        if (!cache.has(key)) cache.set(key, chats.read(scope, id));
        return cache.get(key);
      };
      const change = () => {
        if (table(db, 'project_identity') && db.query<{project_id: string}, []>('SELECT project_id FROM project_identity').get()?.project_id !== projectId) {
          throw Error('Invalid legacy project database owner');
        }
        if (table(db, 'events')) {
          const events = db.query<{type: string; operation_id: string | null; chat_id: string; task_id: string | null; phase: TaskPhase | null; send_id: string | null; pack_id: string | null}, []>(
            'SELECT DISTINCT type, operation_id, chat_id, task_id, phase, send_id, pack_id FROM events WHERE chat_id IS NOT NULL');
          for (const event of events.iterate()) {
            // 削除済みタスクのイベントは参照先の会話が既に削除されている。
            if (!exists(event.task_id) || event.type === 'task.completed' && event.chat_id === event.operation_id &&
                event.send_id === null && event.pack_id === null) continue;
            const chat = read(event.task_id, event.phase, event.chat_id);
            if (!chat || event.send_id !== null && !chat.messages.some(message => message.sendId === event.send_id) ||
                event.pack_id !== null && !chat.packs.some(pack => pack.packId === event.pack_id && (event.send_id === null || pack.sendId === event.send_id))) {
              throw Error('Unresolved project event chat reference');
            }
          }
        }
        if (table(db, 'document_versions')) {
          const versions = db.query<{scope: string; items_json: string}, []>('SELECT scope, items_json FROM document_versions');
          for (const {scope, items_json} of versions.iterate()) {
            if (!owners.has(scope)) continue;
            const items = parseJson(items_json) as {sources: {kind: string; id: string}[]}[];
            for (const item of items) {
              for (const {kind, id} of item.sources) {
                if (kind !== 'message' && kind !== 'result') continue;
                const [phase, chatId, itemId, ...rest] = id.split('/');
                if (!isTaskPhase(phase) || !chatId || !itemId || rest.length) throw Error('Invalid document chat reference');
                const chat = read(scope, phase, chatId);
                if (!(kind === 'message' ? chat?.messages.some(message => message.id === itemId) : chat?.packs.some(pack => pack.packId === itemId))) {
                  throw Error('Unresolved document chat reference');
                }
              }
            }
          }
        }
        if (table(db, 'document_knowledge_completion')) {
          const completions = db.query<{task_id: string; chat_id: string}, []>('SELECT task_id, chat_id FROM document_knowledge_completion').all();
          for (const {task_id, chat_id} of completions) {
            if (!exists(task_id)) continue;
            const ref = chats.resolve({projectId, taskId: task_id, phase: 'finalization'}, chat_id);
            if (!ref) throw Error('Unresolved knowledge completion chat reference');
            if (update && ref.chatId !== chat_id) {
              db.query('UPDATE document_knowledge_completion SET chat_id=? WHERE task_id=? AND chat_id=?').run(ref.chatId, task_id, chat_id);
            }
          }
        }
      };
      if (update) db.transaction(change).immediate();
      else change();
    } finally { db.close(); }
  }
}

export function migrateChatStorage(chats: ChatStore, dataDirectory: string, projects: readonly Project[]) {
  const db = chats.db, root = resolve(dataDirectory), roots = projectRoots(projects);
  const discover = () => inventory(db, root, roots);
  createSchema(db);
  db.transaction(() => prepare(chats, discover().candidates.map(readSource))).immediate();

  const count = db.transaction(() => {
    const pending = records(db);
    if (!pending.length) return 0;
    const current = new Map(discover().candidates.map(candidate => [candidate.path, readSource(candidate)]));
    for (const row of pending) {
      const source = current.get(row.path);
      if (!source && row.state === 'verified') continue;
      if (!sameSource(row, source)) throw Error('Chat source changed during migration');
      if (row.state === 'planned') installTarget(chats, row, source);
    }
    for (const row of pending) {
      const scope = scopeFromKey(row.scope_key);
      verifiedTarget(chats, row);
      chats.publish(scope, row.chat_id, row.archived === 1);
      db.query('INSERT OR IGNORE INTO chat_migration_aliases VALUES (?,?,?)').run(row.scope_key, row.legacy_id, row.chat_id);
      if (chats.resolve(scope, row.legacy_id)?.chatId !== row.chat_id) throw Error('Conflicting legacy chat alias');
    }
    verifyProjectReferences(chats, roots, false);
    return new Set(pending.map(row => row.chat_id)).size;
  }).immediate();
  if (count) {
    // 参照の公開後に別 DB の参照を更新する。再試行時も旧 ID と新 ID の両方を照合できる。
    db.transaction(() => {
      verifyProjectReferences(chats, roots, true);
      verifyProjectReferences(chats, roots, false);
      db.query("UPDATE chat_migration_sources SET state='verified' WHERE state='planned'").run();
    }).immediate();
  }
  const removed = db.transaction(() => {
    const {candidates, cleanup} = discover();
    const current = new Map(candidates.map(candidate => [candidate.path, candidate]));
    const pending = records(db), links = new Map<string, number>();
    for (const row of pending) {
      if (current.has(row.path)) links.set(row.identity, (links.get(row.identity) ?? 0) + 1);
    }
    for (const row of pending) {
      if (row.state !== 'verified') throw Error('Chat migration verification is incomplete');
      verifiedTarget(chats, row);
      const candidate = current.get(row.path);
      if (candidate) {
        const source = readSource(candidate);
        if (!sameSource(row, source) || source.links !== links.get(row.identity)) throw Error('Chat source changed during migration');
        unlinkSync(row.path);
        syncDirectory(dirname(row.path));
        links.set(row.identity, source.links - 1);
      } else if (stat(row.path)) throw Error('Legacy chat is outside its owner directory');
      db.query("UPDATE chat_migration_sources SET state='removed' WHERE path=?").run(row.path);
    }
    for (const path of [...cleanup].sort((a, b) => b.length - a.length)) {
      if (stat(path) && !entries(path).length) rmdirSync(path);
    }
    return pending.length;
  }).immediate();
  return {chats: count, removed};
}
