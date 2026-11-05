import { test, expect, spyOn } from 'bun:test';
import { Store } from './index';
import { Database } from 'bun:sqlite';
import { cpSync, linkSync, symlinkSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId, validProjectId, validTaskId } from '../../shared/ids';
import { cloneProject, migrateData } from '../migration';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'beni-store-'));
  const folder = join(root, 'project');
  mkdirSync(folder);
  return {
    root,
    folder,
    path: join(root, 'beni.sqlite')
  };
}
test('canonical metadata persists tasks and recovers documents idempotently', () => {
  const f = fixture();
  try {
    let store = new Store(f.path);
    const p = store.createProject('Demo', f.folder),
      t = store.createTask(p.id, 'Task');
    expect(validProjectId(p.id)).toBe(true);
    expect(validTaskId(t.id)).toBe(true);
    expect(validProjectId(t.id)).toBe(false);
    expect(readFileSync(join(f.folder, '.beni', 'tasks', t.id, 'requirements.md'), 'utf8')).toBe('# Task\n');
    store.close();
    const orphan = join(f.folder, '.beni', 'tasks', '12');
    mkdirSync(orphan);
    writeFileSync(join(orphan, 'requirements.md'), 'unchanged\r\n');
    store = new Store(f.path);
    const tasks = store.tasks();
    expect(tasks.length).toBe(2);
    const recovered = tasks.find(t => t.name === 'Unknown')!;
    expect(readFileSync(join(f.folder, '.beni', 'tasks', recovered.id, 'requirements.md'), 'utf8')).toBe('unchanged\r\n');
    expect(store.tasks()).toEqual(tasks);
    expect(() => store.createTask(p.id, 'bad', () => {
      throw Error('fail');
    })).toThrow();
    expect(store.tasks().length).toBe(2);
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('moves preserve IDs and live duplicates require explicit clone', async () => {
  const f = fixture();
  try {
    const store = new Store(f.path),
      p = store.createProject('Demo', f.folder),
      t = store.createTask(p.id, 'Task');
    const copy = join(f.root, 'copy');
    const clone = await cloneProject(f.folder, copy);
    expect(clone.projectId).not.toBe(p.id);
    expect(clone.tasks[t.id]).not.toBe(t.id);
    store.createProject('Copy', copy);
    const duplicate = join(f.root, 'duplicate');
    cpSync(f.folder, duplicate, {
      recursive: true
    });
    expect(() => store.createProject('Duplicate', duplicate)).toThrow('Duplicate live project');
    const moved = join(f.root, 'moved');
    renameSync(f.folder, moved);
    expect(store.createProject('Ignored', moved).id).toBe(p.id);
    expect(store.projects().length).toBe(2);
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('legacy store refuses startup; offline migration preserves bytes and history', async () => {
  const f = fixture();
  try {
    const db = new Database(f.path);
    db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,folder TEXT);CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,name TEXT,phase TEXT,status TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,project_id INTEGER,task_id INTEGER,role TEXT,content TEXT);CREATE TABLE documents(id INTEGER PRIMARY KEY,task_id INTEGER,kind TEXT,version INTEGER,content TEXT);`);
    db.query('INSERT INTO projects VALUES (1,?,?)').run('Demo', f.folder);
    db.exec("INSERT INTO tasks VALUES (2,1,'Task','requirements','idle');INSERT INTO messages VALUES (1,1,2,'user','history');INSERT INTO documents VALUES (1,2,'requirements',1,'old');");
    db.close();
    mkdirSync(join(f.folder, '.beni', 'tasks', '2'), {
      recursive: true
    });
    writeFileSync(join(f.folder, '.beni', 'tasks', '2', 'requirements.md'), 'current\r\n');
    mkdirSync(join(f.root, 'chat'));
    const conversation = {
      version: 1,
      id: 'history-id',
      projectId: 1,
      taskId: 2,
      threadId: 'thread',
      sessionId: 'session',
      messages: [{
        id: 'message',
        sendId: 'send',
        provider: 'codex',
        model: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        threadId: 'thread',
        sessionId: 'session',
        role: 'assistant',
        content: 'current',
        status: 'unknown'
      }],
      packs: [{
        packId: 'pack',
        sequence: 1,
        messageId: 'message',
        sendId: 'send',
        role: 'assistant',
        kind: 'text',
        content: 'exact',
        tool: null,
        model: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'unknown',
        state: 'closed'
      }]
    };
    writeFileSync(join(f.root, 'chat', '1-2.json'), JSON.stringify(conversation));
    expect(() => new Store(f.path)).toThrow('migrate:data');
    await migrateData(f.root);
    await migrateData(f.root);
    const store = new Store(f.path),
      task = store.tasks()[0]!;
    expect(readFileSync(join(f.folder, '.beni', 'tasks', task.id, 'requirements.md'), 'utf8')).toBe('current\r\n');
    const migrated = JSON.parse(readFileSync(join(f.folder, '.beni', 'chat', task.id + '.json'), 'utf8'));
    expect(migrated.packs).toEqual(conversation.packs);
    expect(migrated.messages).toEqual(conversation.messages);
    expect(migrated.threadId).toBe('thread');
    expect(JSON.parse(readFileSync(join(f.folder, '.beni', 'legacy-history.json'), 'utf8')).messages[0].content).toBe('history');
    expect(existsSync(join(f.root, 'migrations', 'v1', 'backup', 'beni.sqlite'))).toBe(true);
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('invalid and future metadata and unsafe orphan files are never rewritten', () => {
  const f = fixture();
  try {
    const store = new Store(f.path),
      p = store.createProject('Demo', f.folder);
    const projectFile = join(f.folder, '.beni', 'project.json');
    const original = JSON.parse(readFileSync(projectFile, 'utf8'));
    for (const invalid of [{
      ...original,
      version: 2
    }, {
      ...original,
      createdAt: '2026-02-30T00:00:00.000Z'
    }]) {
      writeFileSync(projectFile, JSON.stringify(invalid));
      expect(() => store.projects()).toThrow();
      expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toEqual(invalid);
    }
    writeFileSync(projectFile, JSON.stringify(original));
    const orphan = join(f.folder, '.beni', 'tasks', '99');
    mkdirSync(orphan);
    writeFileSync(join(f.root, 'outside.md'), 'original');
    linkSync(join(f.root, 'outside.md'), join(orphan, 'requirements.md'));
    expect(() => store.tasks()).toThrow('Invalid document file');
    expect(existsSync(join(orphan, 'task.json'))).toBe(false);
    rmSync(join(orphan, 'requirements.md'));
    symlinkSync(join(f.root, 'missing'), join(orphan, 'task.json'));
    expect(() => store.tasks()).toThrow();
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('interrupted migration reuses journal IDs and refuses changed source rows', async () => {
  const f = fixture();
  try {
    const db = new Database(f.path);
    db.exec('CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,folder TEXT);CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,name TEXT,phase TEXT,status TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,project_id INTEGER,task_id INTEGER,role TEXT,content TEXT);CREATE TABLE documents(id INTEGER PRIMARY KEY,task_id INTEGER,kind TEXT,version INTEGER,content TEXT)');
    db.query('INSERT INTO projects VALUES(1,?,?)').run('Demo', f.folder);
    db.exec("INSERT INTO tasks VALUES(2,1,'Task','requirements','idle')");
    mkdirSync(join(f.root, 'chat'));
    writeFileSync(join(f.root, 'chat', '1-general.json'), JSON.stringify({
      version: 1,
      id: 'c',
      projectId: 1,
      taskId: null,
      messages: [],
      packs: [],
      threadId: null,
      sessionId: null
    }));
    mkdirSync(join(f.folder, '.beni', 'chat'), {
      recursive: true
    });
    const collision = join(f.folder, '.beni', 'chat', 'general.json');
    writeFileSync(collision, '{"preserve":true}');
    await expect(migrateData(f.root)).rejects.toThrow('collision');
    const journalPath = join(f.root, 'migrations', 'v1', 'journal.json'),
      journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(JSON.parse(readFileSync(collision, 'utf8'))).toEqual({
      preserve: true
    });
    db.exec("UPDATE tasks SET name='Changed'");
    await expect(migrateData(f.root)).rejects.toThrow('database changed');
    db.exec("UPDATE tasks SET name='Task'");
    db.close();
    const originalChat = readFileSync(join(f.root, 'chat', '1-general.json'), 'utf8');
    writeFileSync(join(f.root, 'chat', '1-general.json'), originalChat + ' ');
    await expect(migrateData(f.root)).rejects.toThrow('Legacy chat changed');
    expect(readFileSync(join(f.root, 'chat', '1-general.json'), 'utf8')).toBe(originalChat + ' ');
    writeFileSync(join(f.root, 'chat', '1-general.json'), originalChat);
    const originalJournal = readFileSync(journalPath, 'utf8');
    writeFileSync(journalPath, JSON.stringify({
      ...journal,
      version: 2
    }));
    await expect(migrateData(f.root)).rejects.toThrow('invalid migration journal');
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).version).toBe(2);
    writeFileSync(journalPath, originalJournal);
    rmSync(collision);
    await migrateData(f.root);
    const store = new Store(f.path);
    expect(store.tasks()[0]!.id).toBe(journal.tasks['2']);
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).complete).toBe(true);
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('migration retries after verified numeric source removal before SQLite cutover', async () => {
  const f = fixture();
  let transactionSpy: ReturnType<typeof spyOn> | undefined;
  try {
    const db = new Database(f.path);
    db.exec('CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,folder TEXT);CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,name TEXT,phase TEXT,status TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,project_id INTEGER,task_id INTEGER,role TEXT,content TEXT);CREATE TABLE documents(id INTEGER PRIMARY KEY,task_id INTEGER,kind TEXT,version INTEGER,content TEXT)');
    db.query('INSERT INTO projects VALUES(1,?,?)').run('Demo', f.folder);
    db.exec("INSERT INTO tasks VALUES(2,1,'Task','requirements','idle')");
    db.close();
    const old = join(f.folder, '.beni', 'tasks', '2');
    mkdirSync(old, {
      recursive: true
    });
    writeFileSync(join(old, 'requirements.md'), 'verified bytes');
    mkdirSync(join(f.root, 'chat'));
    const chat = await richConversation(2);
    writeFileSync(join(f.root, 'chat', '1-2.json'), JSON.stringify(chat));
    writeFileSync(join(f.root, 'chat', 'unmatched.json'), 'untouched');
    transactionSpy = spyOn(Database.prototype, 'transaction').mockImplementationOnce(() => {
      throw Error('simulated cutover interruption');
    });
    await expect(migrateData(f.root)).rejects.toThrow('simulated cutover interruption');
    transactionSpy.mockRestore();
    transactionSpy = undefined;
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(f.root, 'chat', '1-2.json'))).toBe(false);
    expect(readFileSync(join(f.root, 'chat', 'unmatched.json'), 'utf8')).toBe('untouched');
    expect(() => new Store(f.path)).toThrow('Legacy data');
    const journal = JSON.parse(readFileSync(join(f.root, 'migrations', 'v1', 'journal.json'), 'utf8'));
    await migrateData(f.root);
    const store = new Store(f.path);
    expect(store.tasks()[0]!.id).toBe(journal.tasks['2']);
    expect(JSON.parse(readFileSync(join(f.folder, '.beni', 'chat', journal.tasks['2'] + '.json'), 'utf8')).packs).toEqual(chat.packs);
    expect(readFileSync(join(f.folder, '.beni', 'tasks', journal.tasks['2'], 'requirements.md'), 'utf8')).toBe('verified bytes');
    store.close();
  } finally {
    transactionSpy?.mockRestore();
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
function legacyFixture() {
  const f = fixture(),
    db = new Database(f.path);
  db.exec('CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,folder TEXT);CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,name TEXT,phase TEXT,status TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,project_id INTEGER,task_id INTEGER,role TEXT,content TEXT);CREATE TABLE documents(id INTEGER PRIMARY KEY,task_id INTEGER,kind TEXT,version INTEGER,content TEXT)');
  db.query('INSERT INTO projects VALUES(1,?,?)').run('Demo', f.folder);
  db.exec("INSERT INTO tasks VALUES(2,1,'Task','requirements','idle')");
  db.close();
  mkdirSync(join(f.root, 'chat'));
  return f;
}
async function richConversation(taskId: number | null) {
  const time = '2026-01-01T00:00:00.000Z';
  const messages = [{
    id: 'user-message',
    sendId: 'send',
    role: 'user',
    content: 'request',
    provider: 'codex',
    model: 'example-model',
    createdAt: time,
    updatedAt: time,
    status: 'completed',
    threadId: 'cli-thread',
    sessionId: 'cli-session'
  }, {
    id: 'assistant-message',
    sendId: 'send',
    role: 'assistant',
    content: 'partial answer',
    provider: 'codex',
    model: 'example-model',
    createdAt: time,
    updatedAt: time,
    status: 'streaming',
    threadId: 'cli-thread',
    sessionId: 'cli-session'
  }];
  const packs: any[] = [{
    packId: 'user-pack',
    sequence: 1,
    messageId: 'user-message',
    sendId: 'send',
    role: 'user',
    kind: 'text',
    content: 'request',
    tool: null,
    model: 'example-model',
    createdAt: time,
    status: 'completed',
    state: 'closed'
  }, {
    packId: 'tool-pack',
    sequence: 2,
    messageId: 'assistant-message',
    sendId: 'send',
    role: 'assistant',
    kind: 'tool',
    content: 'exact tool bytes',
    tool: {
      name: 'example-tool',
      input: '{"input":"value"}',
      output: 'failed output'
    },
    model: 'example-model',
    createdAt: time,
    status: 'failed',
    state: 'closed'
  }, {
    packId: 'partial-pack',
    sequence: 3,
    messageId: 'assistant-message',
    sendId: 'send',
    role: 'assistant',
    kind: 'text',
    content: 'partial answer',
    tool: null,
    model: 'example-model',
    createdAt: time,
    status: 'streaming',
    state: 'streaming'
  }];
  const {
    packHash
  } = await import('../../shared/communication');
  for (const pack of packs) pack.hash = await packHash(pack);
  return {
    version: 1,
    id: taskId === null ? 'general-conversation' : 'task-conversation',
    projectId: 1,
    taskId,
    threadId: 'cli-thread',
    sessionId: 'cli-session',
    messages,
    packs
  };
}
test('migration preserves general and task chat packs; clone detaches unfinished CLI sessions', async () => {
  const f = legacyFixture();
  try {
    const general = await richConversation(null),
      task = await richConversation(2),
      generalBytes = JSON.stringify(general),
      taskBytes = JSON.stringify(task);
    writeFileSync(join(f.root, 'chat', '1-general.json'), generalBytes);
    writeFileSync(join(f.root, 'chat', '1-2.json'), taskBytes);
    await migrateData(f.root);
    const store = new Store(f.path),
      project = store.projects()[0]!,
      migratedTask = store.tasks()[0]!;
    for (const [name, original] of [['general.json', general], [migratedTask.id + '.json', task]] as const) {
      const migrated = JSON.parse(readFileSync(join(f.folder, '.beni', 'chat', name), 'utf8'));
      expect(migrated.projectId).toBe(project.id);
      expect(migrated.taskId).toBe(name === 'general.json' ? null : migratedTask.id);
      expect(migrated.id).toBe(original.id);
      expect(migrated.packs).toEqual(original.packs);
      expect(migrated.messages).toEqual(original.messages);
      expect(migrated.threadId).toBe(original.threadId);
      expect(migrated.sessionId).toBe(original.sessionId);
    }
    expect(existsSync(join(f.root, 'chat', '1-general.json'))).toBe(false);
    expect(existsSync(join(f.root, 'chat', '1-2.json'))).toBe(false);
    expect(readFileSync(join(f.root, 'migrations', 'v1', 'backup', 'chat', '1-general.json'), 'utf8')).toBe(generalBytes);
    expect(readFileSync(join(f.root, 'migrations', 'v1', 'backup', 'chat', '1-2.json'), 'utf8')).toBe(taskBytes);
    const destination = join(f.root, 'clone');
    mkdirSync(destination);
    writeFileSync(join(destination, 'existing-project.txt'), 'preserved');
    const clone = await cloneProject(f.folder, destination);
    expect(clone.projectId).not.toBe(project.id);
    expect(clone.tasks[migratedTask.id]).not.toBe(migratedTask.id);
    for (const filename of ['general.json', clone.tasks[migratedTask.id] + '.json']) {
      const cloned = JSON.parse(readFileSync(join(destination, '.beni', 'chat', filename), 'utf8'));
      expect(cloned.projectId).toBe(clone.projectId);
      expect(cloned.threadId).toBe(null);
      expect(cloned.sessionId).toBe(null);
      expect(cloned.messages.every((m: any) => m.threadId === null && m.sessionId === null)).toBe(true);
      expect(cloned.messages[1].status).toBe('unknown');
      expect(cloned.packs.map((p: any) => p.packId)).toEqual(task.packs.map(p => p.packId));
      expect(cloned.packs[1]).toEqual(task.packs[1]);
      expect(cloned.packs[2]).toEqual({
        ...task.packs[2],
        status: 'unknown',
        state: 'closed'
      });
    }
    expect(readFileSync(join(destination, 'existing-project.txt'), 'utf8')).toBe('preserved');
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('mismatched chat scope and malformed message or pack history prevent migration cutover', async () => {
  for (const invalid of ['scope', 'sendId', 'model', 'date', 'order', 'duplicate']) {
    const f = legacyFixture();
    try {
      const conversation = await richConversation(2);
      if (invalid === 'scope') conversation.projectId = 99;
      if (invalid === 'sendId') (conversation.messages[0] as any).sendId = null;
      if (invalid === 'model') (conversation.messages[0] as any).model = 42;
      if (invalid === 'date') conversation.messages[0]!.createdAt = 'invalid';
      if (invalid === 'order') conversation.packs[1].sequence = 8;
      if (invalid === 'duplicate') conversation.packs[1].packId = conversation.packs[0].packId;
      const original = JSON.stringify(conversation);
      writeFileSync(join(f.root, 'chat', '1-2.json'), original);
      await expect(migrateData(f.root)).rejects.toThrow();
      expect(() => new Store(f.path)).toThrow('Legacy data');
      expect(readFileSync(join(f.root, 'chat', '1-2.json'), 'utf8')).toBe(original);
    } finally {
      rmSync(f.root, {
        recursive: true,
        force: true
      });
    }
  }
});
test('clone publishes only a fully validated .beni and leaves failed source and destination intact', async () => {
  const f = fixture();
  try {
    const store = new Store(f.path),
      project = store.createProject('Demo', f.folder),
      task = store.createTask(project.id, 'Task');
    const chatDirectory = join(f.folder, '.beni', 'chat');
    mkdirSync(chatDirectory);
    const chatPath = join(chatDirectory, task.id + '.json');
    const valid: any = await richConversation(2);
    Object.assign(valid, {
      projectId: project.id,
      taskId: task.id
    });
    const destination = join(f.root, 'destination');
    mkdirSync(destination);
    const existing = join(destination, 'existing.txt');
    writeFileSync(existing, 'existing bytes');
    for (const invalid of ['json', 'project-scope', 'task-scope']) {
      const value = structuredClone(valid);
      if (invalid === 'project-scope') value.projectId = generateId('project');
      if (invalid === 'task-scope') value.taskId = generateId('task');
      const bytes = invalid === 'json' ? '{ malformed original JSON' : JSON.stringify(value);
      writeFileSync(chatPath, bytes);
      const sourceMetadata = readFileSync(join(f.folder, '.beni', 'project.json'), 'utf8');
      await expect(cloneProject(f.folder, destination)).rejects.toThrow();
      expect(existsSync(join(destination, '.beni'))).toBe(false);
      expect(readFileSync(existing, 'utf8')).toBe('existing bytes');
      expect(readFileSync(chatPath, 'utf8')).toBe(bytes);
      expect(readFileSync(join(f.folder, '.beni', 'project.json'), 'utf8')).toBe(sourceMetadata);
      expect((await import('node:fs')).readdirSync(destination)).toEqual(['existing.txt']);
    }
    writeFileSync(chatPath, JSON.stringify(valid));
    const cloned = await cloneProject(f.folder, destination);
    expect(existsSync(join(destination, '.beni', 'project.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(destination, '.beni', 'chat', cloned.tasks[task.id] + '.json'), 'utf8')).projectId).toBe(cloned.projectId);
    expect(readFileSync(chatPath, 'utf8')).toBe(JSON.stringify(valid));
    expect(readFileSync(existing, 'utf8')).toBe('existing bytes');
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('clone rejects missing source data and destination symlinks without creating metadata', async () => {
  const f = fixture();
  try {
    const destination = join(f.root, 'destination');
    mkdirSync(destination);
    await expect(cloneProject(f.folder, destination)).rejects.toThrow();
    expect(existsSync(join(f.folder, '.beni'))).toBe(false);
    expect(existsSync(join(destination, '.beni'))).toBe(false);
    const store = new Store(f.path);
    store.createProject('Demo', f.folder);
    const alias = join(f.root, 'alias');
    symlinkSync(destination, alias);
    await expect(cloneProject(f.folder, alias)).rejects.toThrow();
    expect(existsSync(join(destination, '.beni'))).toBe(false);
    symlinkSync(join(f.root, 'missing'), join(destination, '.beni'));
    await expect(cloneProject(f.folder, destination)).rejects.toThrow();
    expect((await import('node:fs')).lstatSync(join(destination, '.beni')).isSymbolicLink()).toBe(true);
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('clone rejects its source .beni as destination without changing source entries', async () => {
  const f = fixture();
  try {
    const store = new Store(f.path),
      project = store.createProject('Demo', f.folder);
    store.createTask(project.id, 'Task');
    const source = join(f.folder, '.beni'),
      metadataPath = join(source, 'project.json'),
      before = readFileSync(metadataPath, 'utf8'),
      fs = await import('node:fs'),
      entries = fs.readdirSync(source).sort();
    await expect(cloneProject(f.folder, source)).rejects.toThrow('inside source data');
    expect(fs.readdirSync(source).sort()).toEqual(entries);
    expect(readFileSync(metadataPath, 'utf8')).toBe(before);
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('clone rejects source data reached through an ancestor alias before creating anything', async () => {
  const f = fixture();
  try {
    const store = new Store(f.path),
      project = store.createProject('Demo', f.folder);
    store.createTask(project.id, 'Task');
    const alias = join(f.root, 'alias');
    symlinkSync(f.folder, alias);
    const fs = await import('node:fs'),
      source = join(f.folder, '.beni'),
      before = fs.readdirSync(source).sort(),
      bytes = readFileSync(join(source, 'project.json'), 'utf8');
    for (const destination of [join(alias, '.beni'), join(alias, '.beni', 'new-destination')]) {
      await expect(cloneProject(f.folder, destination)).rejects.toThrow('inside source data');
      expect(fs.readdirSync(source).sort()).toEqual(before);
      expect(readFileSync(join(source, 'project.json'), 'utf8')).toBe(bytes);
    }
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});

test('task rows expose canonical creation dates including unknown dates', () => {
  const f = fixture();
  const store = new Store(f.path);
  try {
    const project = store.createProject('Demo', f.folder);
    const task = store.createTask(project.id, 'Task');
    const path = join(f.folder, '.beni', 'tasks', task.id, 'task.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(task.createdAt).toBe(data.createdAt);
    expect(task.updatedAt).toBe(data.updatedAt);
    data.createdAt = '2026-01-02T03:04:05.000Z';
    data.updatedAt = '2026-02-03T04:05:06.000Z';
    writeFileSync(path, JSON.stringify(data));
    expect(store.tasks(project.id)[0]!.createdAt).toBe(data.createdAt);
    expect(store.task(task.id)!.createdAt).toBe(data.createdAt);
    expect(store.task(task.id)!.updatedAt).toBe(data.updatedAt);
    data.createdAt = null;
    data.updatedAt = null;
    writeFileSync(path, JSON.stringify(data));
    expect(store.task(task.id)!.createdAt).toBeNull();
    expect(store.task(task.id)!.updatedAt).toBeNull();
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('document activity survives restart and ignores initial unknown dates and timestamp-only changes', async () => {
  const f = fixture(); let store = new Store(f.path);
  try {
    const project = store.createProject('Demo', f.folder), task = store.createTask(project.id, 'Task');
    const path = join(f.folder, '.beni', 'tasks', task.id), file = join(path, 'task.json');
    const original = JSON.parse(readFileSync(file, 'utf8'));
    original.createdAt = null; original.updatedAt = null; delete original.documentBaseline;
    writeFileSync(file, JSON.stringify(original));
    expect(store.tasks()[0]!.updatedAt).toBeNull();
    const baseline = readFileSync(file, 'utf8');
    expect(store.tasks()[0]!.updatedAt).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(baseline);
    store.close(); await Bun.sleep(5);
    writeFileSync(join(path, 'requirements.md'), '# Offline edit\n');
    store = new Store(f.path);
    const edited = store.tasks()[0]!;
    expect(edited.createdAt).toBeNull(); expect(edited.updatedAt).not.toBeNull();
    writeFileSync(join(path, 'large.md'), 'a'.repeat(1024 * 1024 + 1));
    expect(store.tasks()).toHaveLength(1);
    rmSync(join(path, 'large.md'));
    const stable = store.tasks()[0]!.updatedAt;
    writeFileSync(join(path, 'requirements.md'), '# Offline edit\n');
    expect(store.tasks()[0]!.updatedAt).toBe(stable);
    const {statSync, utimesSync} = await import('node:fs');
    const priorStat = statSync(join(path, 'requirements.md'));
    await Bun.sleep(5);
    writeFileSync(join(path, 'requirements.md'), '# Preserved timestamp edit\n');
    utimesSync(join(path, 'requirements.md'), priorStat.atime, priorStat.mtime);
    // A preserved (or older rounded) timestamp must never regress a newer activity.
    const preserved = store.tasks()[0]!.updatedAt;
    expect(preserved! >= stable!).toBe(true);
    await Bun.sleep(5); rmSync(join(path, 'requirements.md'));
    expect(store.tasks()[0]!.updatedAt! > stable!).toBe(true);
    const removed = store.task(task.id)!.updatedAt;
    store.taskDocumentFolder(project.id, task.id);
    expect(store.task(task.id)!.updatedAt).toBe(removed);
    mkdirSync(join(f.root, 'other'));
    const other = store.createProject('Other', join(f.root, 'other'));
    expect(() => store.touchTask(other.id, task.id)).toThrow('Unknown task');
  } finally { store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('task deletion removes only scoped documents and chat and rejects unsafe chat links', () => {
 const f=fixture(), store=new Store(f.path);
 try {
  const p=store.createProject('Demo',f.folder), target=store.createTask(p.id,'Target'), other=store.createTask(p.id,'Other');
  const root=join(f.folder,'.beni'), chats=join(root,'chat');mkdirSync(chats);
  for(const name of ['general.json',`${target.id}.json`,`${other.id}.json`])writeFileSync(join(chats,name),'{}');
  mkdirSync(join(root,'old'));writeFileSync(join(root,'old','archive.json'),'archive');
  const external=join(f.root,'external.json');writeFileSync(external,'safe');rmSync(join(chats,`${target.id}.json`));symlinkSync(external,join(chats,`${target.id}.json`));
  expect(()=>store.deleteTask(p.id,target.id)).toThrow('Invalid chat file');expect(store.task(target.id)).not.toBeNull();expect(readFileSync(external,'utf8')).toBe('safe');
  rmSync(join(chats,`${target.id}.json`));writeFileSync(join(chats,`${target.id}.json`),'{}');
  expect(()=>store.deleteTask(generateId('project'),target.id)).toThrow();
  store.deleteTask(p.id,target.id);
  expect(store.tasks().map(t=>t.id)).toEqual([other.id]);expect(existsSync(join(chats,`${target.id}.json`))).toBe(false);
  expect(readFileSync(join(chats,'general.json'),'utf8')).toBe('{}');expect(readFileSync(join(chats,`${other.id}.json`),'utf8')).toBe('{}');expect(readFileSync(join(root,'old','archive.json'),'utf8')).toBe('archive');
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('task deletion recovery rolls back incomplete moves and never restores committed partial cleanup', () => {
 const f=fixture(),store=new Store(f.path);
 try {
  const p=store.createProject('Demo',f.folder),t=store.createTask(p.id,'Target'),root=join(f.folder,'.beni');mkdirSync(join(root,'chat'));
  const staged=join(root,`.deleting-${t.id}`);mkdirSync(staged);writeFileSync(join(staged,'journal.json'),JSON.stringify({version:1,projectId:p.id,taskId:t.id}));
  renameSync(join(root,'tasks',t.id),join(staged,'task'));writeFileSync(join(staged,'chat.json'),'{}');
  expect(store.tasks().map(t=>t.id)).toContain(t.id);expect(readFileSync(join(root,'chat',`${t.id}.json`),'utf8')).toBe('{}');expect(existsSync(staged)).toBe(false);
  mkdirSync(staged);renameSync(join(root,'tasks',t.id),join(staged,'task'));renameSync(join(root,'chat',`${t.id}.json`),join(staged,'chat.json'));
  writeFileSync(join(staged,'committed.json'),JSON.stringify({version:1,projectId:p.id,taskId:t.id}));rmSync(join(staged,'task','task.json'));
  expect(store.tasks()).toEqual([]);expect(existsSync(staged)).toBe(false);expect(existsSync(join(root,'chat',`${t.id}.json`))).toBe(false);
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('task deletion rolls back filesystem failures before commit', async () => {
 const f=fixture(),store=new Store(f.path),fs=await import('node:fs');
 const original=fs.renameSync;
 let fault:ReturnType<typeof spyOn>|undefined;
 try {
  const p=store.createProject('Demo',f.folder),t=store.createTask(p.id,'Target'),root=join(f.folder,'.beni');mkdirSync(join(root,'chat'));writeFileSync(join(root,'chat',`${t.id}.json`),'history');
  fault=spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to).endsWith('/committed.json'))throw Error('simulated filesystem failure');return original(from,to)});
  expect(()=>store.deleteTask(p.id,t.id)).toThrow('simulated filesystem failure');fault.mockRestore();fault=undefined;
  expect(store.task(t.id)?.name).toBe('Target');expect(readFileSync(join(root,'tasks',t.id,'requirements.md'),'utf8')).toBe('# Target\n');expect(readFileSync(join(root,'chat',`${t.id}.json`),'utf8')).toBe('history');
  store.deleteTask(p.id,t.id);expect(store.tasks()).toEqual([]);
 }finally{fault?.mockRestore();store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('recovery discards an initial journal write interrupted before any source was moved', async () => {
 const f=fixture(),store=new Store(f.path);
 try {
  const p=store.createProject('Demo',f.folder),t=store.createTask(p.id,'Target'),staged=join(f.folder,'.beni',`.deleting-${t.id}`);mkdirSync(staged);writeFileSync(join(staged,'journal.json.tmp-00000000-0000-0000-0000-000000000000'),'{');
  const clone=join(f.root,'clone');await expect(cloneProject(f.folder,clone)).rejects.toThrow('Pending task deletion');expect(existsSync(join(clone,'.beni'))).toBe(false);
  expect(store.tasks().map(t=>t.id)).toEqual([t.id]);expect(existsSync(staged)).toBe(false);
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('task history retains created, updated, renamed and deleted document versions across restart', () => {
  const f = fixture(); let store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const folder = join(f.folder, '.beni', 'tasks', task.id);
    const initial = store.taskEvents(p.id, task.id);
    expect(initial.events.map(event => event.type)).toEqual(['document.created', 'document.created', 'document.created']);
    expect(initial.events.every(event => event.sourcePhase === null)).toBe(true);
    const original = initial.events.find(event => event.path === 'requirements.md')!;
    writeFileSync(join(folder, 'requirements.md'), 'updated\r\n');
    store.reconcileTaskDocuments(p.id, task.id);
    const updated = store.taskEvents(p.id, task.id, initial.lastEventId).events[0]!;
    expect(updated).toMatchObject({type: 'document.updated', previousVersion: original.version, path: 'requirements.md', sourcePhase: null});
    renameSync(join(folder, 'requirements.md'), join(folder, 'notes.md'));
    const renamed = store.taskEvents(p.id, task.id, updated.id).events[0]!;
    expect(renamed).toMatchObject({type: 'document.renamed', previousPath: 'requirements.md', path: 'notes.md', version: updated.version});
    rmSync(join(folder, 'notes.md'));
    const deleted = store.taskEvents(p.id, task.id, renamed.id).events[0]!;
    expect(deleted).toMatchObject({type: 'document.deleted', path: 'notes.md', version: updated.version});
    store.close(); store = new Store(f.path);
    expect(store.taskEvents(p.id, task.id).lastEventId).toBe(deleted.id);
    expect(store.taskEventVersion(p.id, task.id, original.version!).content).toBe('# Task\n');
    expect(store.taskEventVersion(p.id, task.id, deleted.version!).content).toBe('updated\r\n');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('history pagination fixes through and validates unknown cursors and references', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const first = store.taskEvents(p.id, task.id, 0, undefined, 1);
    expect(first).toMatchObject({lastEventId: 1, through: 3, hasMore: true});
    writeFileSync(join(f.folder, '.beni', 'tasks', task.id, 'extra.md'), 'later');
    const next = store.taskEvents(p.id, task.id, first.lastEventId, first.through, 100);
    expect(next.events.map(event => event.id)).toEqual([2, 3]);
    expect(next).toMatchObject({lastEventId: 3, through: 3, hasMore: false});
    expect(store.taskEvents(p.id, task.id, 3).events.map(event => event.id)).toEqual([4]);
    expect(store.taskEvents(p.id, task.id, 3, 3).lastEventId).toBe(3);
    for (const args of [[-1], [1.5], [0, 1.5], [3, 2], [0, undefined, 0], [0, undefined, 101]] as [number, number?, number?][]) expect(() => store.taskEvents(p.id, task.id, ...args)).toThrow('Invalid event cursor');
    expect(() => store.taskEvents(p.id, task.id, 99)).toThrow('Unknown event cursor');
    expect(() => store.taskEvents(p.id, task.id, 0, 99)).toThrow('Unknown event cursor');
    expect(() => store.taskEventVersion(p.id, task.id, '../task.json')).toThrow('Invalid history version');
    expect(() => store.taskEventVersion(p.id, task.id, '0'.repeat(64))).toThrow('Unknown history version');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('ambiguous document moves stay separate events and phase transitions preserve history', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), folder = join(f.folder, '.beni', 'tasks', task.id);
    writeFileSync(join(folder, 'one.md'), 'same'); writeFileSync(join(folder, 'two.md'), 'same');
    const before = store.taskEvents(p.id, task.id).lastEventId;
    renameSync(join(folder, 'one.md'), join(folder, 'three.md')); renameSync(join(folder, 'two.md'), join(folder, 'four.md'));
    expect(store.taskEvents(p.id, task.id, before).events.map(event => event.type)).toEqual(['document.deleted', 'document.deleted', 'document.created', 'document.created']);
    const start = store.taskEvents(p.id, task.id).lastEventId;
    store.advanceTaskPhase(p.id, task.id, 'requirements');
    store.advanceTaskPhase(p.id, task.id, 'documents', 'back');
    expect(store.taskEvents(p.id, task.id, start).events).toMatchObject([
      {type: 'phase.changed', from: 'requirements', to: 'documents', sourcePhase: 'requirements'},
      {type: 'phase.changed', from: 'documents', to: 'requirements', sourcePhase: 'documents'}
    ]);
    // メタデータ更新後・履歴確定前に中断した状態も次の照合で取り込む。
    const file = join(folder, 'task.json'), value = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({...value, phase: 'implementation-plan'}));
    expect(store.taskEvents(p.id, task.id).events.at(-1)).toMatchObject({type: 'phase.changed', from: 'requirements', to: 'implementation-plan', sourcePhase: null});
    expect(() => store.advanceTaskPhase(p.id, task.id, 'requirements')).toThrow('phase conflict');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('history rejects linked or corrupted indexes, blobs and current documents', () => {
  for (const target of ['index', 'blob', 'document', 'hardlink', 'snapshot', 'hash']) {
    const f = fixture(), store = new Store(f.path);
    try {
      const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), folder = join(f.folder, '.beni', 'tasks', task.id);
      const history = join(folder, '.history'), initial = store.taskEvents(p.id, task.id), version = initial.events[0]!.version!;
      const file = target === 'index' || target === 'snapshot' ? join(history, 'index.json') : target === 'document' ? join(folder, 'requirements.md') : join(history, 'versions', version + '.md');
      const external = join(f.root, 'external'); writeFileSync(external, 'outside');
      if (target === 'snapshot') {
        const value = JSON.parse(readFileSync(file, 'utf8')); value.snapshot['requirements.md'] = '0'.repeat(64); writeFileSync(file, JSON.stringify(value));
      } else if (target === 'hash') writeFileSync(file, 'corrupt');
      else { rmSync(file); if (target === 'hardlink') linkSync(external, file); else symlinkSync(external, file); }
      expect(() => store.taskEvents(p.id, task.id)).toThrow();
      expect(readFileSync(external, 'utf8')).toBe('outside');
    } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
  }
});

test('clone retains task history while detaching all phase conversations and their cursors', async () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const root = join(f.folder, '.beni'), chat = join(root, 'chat', task.id); mkdirSync(chat, {recursive: true});
    const original = {
      version: 1, id: 'conversation', projectId: p.id, taskId: task.id,
      phase: 'requirements', lastEventId: 3, threadId: 'thread', sessionId: 'session',
      messages: [{id: 'message', sendId: 'send', role: 'user', content: 'Example', provider: 'codex', model: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', threadId: 'thread', sessionId: 'session', status: 'completed'}], packs: []
    };
    for (const phase of ['requirements', 'documents']) writeFileSync(join(chat, phase + '.json'), JSON.stringify({...original, phase, id: phase}));
    const before = store.taskEvents(p.id, task.id), destination = join(f.root, 'clone'), clone = await cloneProject(f.folder, destination);
    const clonedId = clone.tasks[task.id]!;
    store.createProject('Clone', destination);
    expect(store.taskEvents(clone.projectId, clonedId)).toEqual(before);
    for (const phase of ['requirements', 'documents']) {
      const value = JSON.parse(readFileSync(join(destination, '.beni', 'chat', clonedId, phase + '.json'), 'utf8'));
      expect(value).toMatchObject({projectId: clone.projectId, taskId: clonedId, phase, lastEventId: 0, threadId: null, sessionId: null});
      expect(value.id).not.toBe(phase);
      expect(value.messages[0]).toMatchObject({threadId: null, sessionId: null});
    }
    // 旧会話と全フェーズの会話が併存していても削除対象はタスク内に閉じる。
    writeFileSync(join(root, 'chat', task.id + '.json'), JSON.stringify(original));
    store.deleteTask(p.id, task.id);
    expect(existsSync(join(root, 'tasks', task.id))).toBe(false);
    expect(existsSync(chat)).toBe(false);
    expect(existsSync(join(root, 'chat', task.id + '.json'))).toBe(false);
    expect(store.taskEvents(clone.projectId, clonedId)).toEqual(before);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('phase chat deletion recovery restores uncommitted directories and rejects links', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), root = join(f.folder, '.beni');
    const chat = join(root, 'chat', task.id); mkdirSync(chat, {recursive: true});
    writeFileSync(join(chat, 'requirements.json'), '{}');
    const staged = join(root, `.deleting-${task.id}`); mkdirSync(staged);
    writeFileSync(join(staged, 'journal.json'), JSON.stringify({version: 1, projectId: p.id, taskId: task.id}));
    renameSync(join(root, 'tasks', task.id), join(staged, 'task')); renameSync(chat, join(staged, 'chat'));
    expect(store.tasks(p.id).map(value => value.id)).toEqual([task.id]);
    expect(readFileSync(join(chat, 'requirements.json'), 'utf8')).toBe('{}');
    const external = join(f.root, 'external.json'); writeFileSync(external, '{}');
    symlinkSync(external, join(chat, 'documents.json'));
    expect(() => store.deleteTask(p.id, task.id)).toThrow('Invalid metadata file');
    expect(store.task(task.id)).not.toBeNull();
    rmSync(join(chat, 'documents.json'));
    // 確定済みジャーナルは残ったフェーズ会話を復元せず削除する。
    mkdirSync(staged); writeFileSync(join(staged, 'committed.json'), JSON.stringify({version: 1, projectId: p.id, taskId: task.id}));
    renameSync(join(root, 'tasks', task.id), join(staged, 'task')); renameSync(chat, join(staged, 'chat'));
    expect(store.tasks(p.id)).toEqual([]); expect(existsSync(staged)).toBe(false);
    expect(readFileSync(external, 'utf8')).toBe('{}');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('history publishes blobs before its index and retries a failed commit without event gaps', async () => {
  const f = fixture(), store = new Store(f.path), fs = await import('node:fs'), original = fs.renameSync;
  let fault: ReturnType<typeof spyOn> | undefined;
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), folder = join(f.folder, '.beni', 'tasks', task.id);
    const before = store.taskEvents(p.id, task.id), index = join(folder, '.history', 'index.json'), saved = readFileSync(index, 'utf8');
    writeFileSync(join(folder, 'extra.md'), 'new version');
    fault = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === index) throw Error('simulated history commit failure');
      return original(from, to);
    });
    expect(() => store.captureTaskHistory(p.id, task.id, 'documents')).toThrow('simulated history commit failure');
    fault.mockRestore(); fault = undefined;
    expect(readFileSync(index, 'utf8')).toBe(saved);
    const crypto = await import('node:crypto'), version = crypto.createHash('sha256').update('new version').digest('hex');
    expect(readFileSync(join(folder, '.history', 'versions', version + '.md'), 'utf8')).toBe('new version');
    expect(() => store.taskEventVersion(p.id, task.id, version)).toThrow('Unknown history version');
    // 中断時の一時本文はhash名を持たず、未完成でも公開履歴に影響しない。
    writeFileSync(join(folder, '.history', 'versions', '.tmp-abandoned'), 'partial');
    store.captureTaskHistory(p.id, task.id, 'documents');
    expect(store.taskEvents(p.id, task.id, before.lastEventId).events).toMatchObject([{id: before.lastEventId + 1, type: 'document.created', path: 'extra.md', sourcePhase: 'documents', version}]);
  } finally { fault?.mockRestore(); store.close(); rmSync(f.root, {recursive: true, force: true}); }
});
