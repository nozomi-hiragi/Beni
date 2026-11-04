import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Instruction = { id: string; content: string };

/** Import the authoritative task chat into workflow instructions, once per message. */
export function syncChat(db: Database, taskId: number, chatDirectory: string): void {
  const task = db.query('SELECT project_id FROM tasks WHERE id=?').get(taskId) as { project_id: number } | null;
  if (!task) throw Error('Task missing');
  let raw: string | undefined;
  try { raw = readFileSync(join(chatDirectory, `${task.project_id}-${taskId}.json`), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_chat_imports(task_id INTEGER PRIMARY KEY REFERENCES tasks(id), conversation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_chat_instructions(task_id INTEGER NOT NULL REFERENCES tasks(id), chat_id TEXT NOT NULL, position INTEGER NOT NULL, content TEXT NOT NULL, message_id INTEGER NOT NULL REFERENCES messages(id), PRIMARY KEY(task_id,chat_id), UNIQUE(task_id,position));`);
    const imported = db.query('SELECT conversation_id FROM workflow_chat_imports WHERE task_id=?').get(taskId) as { conversation_id: string } | null;
    if (raw === undefined) { if (imported) throw Error('Imported chat history missing'); return; }
    const c: any = JSON.parse(raw);
    if (!c || c.version !== 1 || c.projectId !== task.project_id || c.taskId !== taskId || typeof c.id !== 'string' || !uuid.test(c.id) || !Array.isArray(c.messages)) throw Error('Invalid chat history');
    if (imported && imported.conversation_id !== c.id) throw Error('Chat history changed');
    const seen = new Set<string>();
    const instructions: Instruction[] = [];
    for (const message of c.messages) {
      if (!message || typeof message.id !== 'string' || !uuid.test(message.id) || seen.has(message.id.toLowerCase()) || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw Error('Invalid chat history');
      seen.add(message.id.toLowerCase());
      if (message.role === 'user') {
        if (!message.content.trim()) throw Error('Invalid chat instruction');
        instructions.push({ id: message.id.toLowerCase(), content: message.content });
      }
    }
    const previous = db.query('SELECT chat_id,content FROM workflow_chat_instructions WHERE task_id=? ORDER BY position').all(taskId) as { chat_id: string; content: string }[];
    if (previous.length > instructions.length || previous.some((row, i) => row.chat_id !== instructions[i].id || row.content !== instructions[i].content)) throw Error('Imported chat history changed');
    if (!imported) db.query('INSERT INTO workflow_chat_imports(task_id,conversation_id) VALUES (?,?)').run(taskId, c.id);
    for (let i = previous.length; i < instructions.length; i++) {
      const instruction = instructions[i];
      const messageId = Number(db.query("INSERT INTO messages(project_id,task_id,role,content) VALUES (?,?,'user',?)").run(task.project_id, taskId, instruction.content).lastInsertRowid);
      db.query('INSERT INTO workflow_chat_instructions(task_id,chat_id,position,content,message_id) VALUES (?,?,?,?,?)').run(taskId, instruction.id, i, instruction.content, messageId);
      db.query("INSERT INTO workflow_events(task_id,kind,payload) VALUES (?,'instruction',?)").run(taskId, JSON.stringify({ messageId, original: instruction.content }));
    }
  }).immediate();
}
