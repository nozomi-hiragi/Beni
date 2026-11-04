import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { syncChat } from './chat-sync';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-sync-'));
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER); INSERT INTO tasks VALUES(1,2);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,project_id INTEGER,task_id INTEGER,role TEXT,content TEXT);
    CREATE TABLE workflow_events(id INTEGER PRIMARY KEY,task_id INTEGER,kind TEXT,payload TEXT);`);
  const chat = { version: 1, id: randomUUID(), projectId: 2, taskId: 1, messages: [] as {id:string;role:string;content:string}[] };
  const path = join(dir, '2-1.json');
  const save = () => writeFileSync(path, JSON.stringify(chat));
  const close = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, db, chat, path, save, close };
}

test('imports all user messages exactly once, preserving originals', () => {
  const f = fixture(); try {
    syncChat(f.db, 1, f.dir);
    f.chat.messages.push({id:randomUUID(),role:'user',content:'  original  '}, {id:randomUUID(),role:'assistant',content:'reply'}, {id:randomUUID(),role:'user',content:'next'});
    f.save(); syncChat(f.db, 1, f.dir); syncChat(f.db, 1, f.dir);
    expect(f.db.query('SELECT content FROM messages ORDER BY id').all()).toEqual([{content:'  original  '},{content:'next'}]);
    expect((f.db.query('SELECT payload FROM workflow_events ORDER BY id').all() as any[]).map(e => JSON.parse(e.payload).original)).toEqual(['  original  ', 'next']);
    f.chat.messages.push({id:randomUUID(),role:'user',content:'third'}); f.save(); syncChat(f.db, 1, f.dir);
    expect(f.db.query('SELECT * FROM messages').all()).toHaveLength(3);
  } finally { f.close(); }
});

test('rejects edited, deleted, reordered, duplicated or missing history', () => {
  for (const mode of ['edit','delete','reorder','duplicate','missing'] as const) {
    const f = fixture(); try {
      f.chat.messages.push({id:randomUUID(),role:'user',content:'first'}, {id:randomUUID(),role:'user',content:'second'}); f.save(); syncChat(f.db,1,f.dir);
      if (mode === 'edit') f.chat.messages[0].content = 'changed';
      if (mode === 'delete') f.chat.messages.shift();
      if (mode === 'reorder') f.chat.messages.reverse();
      if (mode === 'duplicate') f.chat.messages.push({...f.chat.messages[0]});
      if (mode === 'missing') unlinkSync(f.path); else f.save();
      expect(() => syncChat(f.db,1,f.dir)).toThrow();
      expect(f.db.query('SELECT * FROM messages').all()).toHaveLength(2);
      expect(f.db.query('SELECT * FROM workflow_events').all()).toHaveLength(2);
    } finally { f.close(); }
  }
});

test('rolls back messages and import markers on event failure', () => {
  const f = fixture(); try {
    f.chat.messages.push({id:randomUUID(),role:'user',content:'one'}); f.save();
    f.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON workflow_events BEGIN SELECT RAISE(ABORT,'rejected'); END");
    expect(() => syncChat(f.db,1,f.dir)).toThrow();
    expect(f.db.query('SELECT * FROM messages').all()).toHaveLength(0);
    f.db.exec('DROP TRIGGER reject_event'); syncChat(f.db,1,f.dir);
    expect(f.db.query('SELECT * FROM messages').all()).toHaveLength(1);
    expect(f.db.query('SELECT * FROM workflow_events').all()).toHaveLength(1);
  } finally { f.close(); }
});
