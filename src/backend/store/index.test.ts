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
