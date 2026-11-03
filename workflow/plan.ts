import { Database } from 'bun:sqlite';

export interface PlanSnapshot {
  taskId: number;
  taskName: string;
  instructions: { id: number; content: string }[];
  reviewFeedback: { eventId: number; reviewId: number; attemptId: number; content: string }[];
  reviewIssues: { eventId: number; reviewId: number; attemptId: number; status: string }[];
  requirements: { version: number; content: string };
  previousPlan: { version: number; content: string } | null;
}
export interface PlanAdapter {
  generate(snapshot: PlanSnapshot, signal: AbortSignal): Promise<{ content: string }>;
}
const nonempty = (value: string) => {
  if (typeof value !== 'string' || !value.trim()) throw Error('Nonempty text required');
  return value;
};

/** Reopening does not resume external work; unknown outcomes require acknowledgement. */
export class PlanGeneration {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS workflow_events(id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS plan_generations(id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL REFERENCES tasks(id),request_key TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT NOT NULL,result TEXT,acknowledged_by TEXT,UNIQUE(task_id,request_key));
      CREATE UNIQUE INDEX IF NOT EXISTS one_plan_generation ON plan_generations(task_id) WHERE status='running';
      CREATE TABLE IF NOT EXISTS plan_generation_events(id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL REFERENCES tasks(id),attempt_id INTEGER NOT NULL REFERENCES plan_generations(id),kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  }
  close() { this.db.close(); }
  private event(taskId: number, id: number, kind: string, payload: unknown) {
    this.db.query('INSERT INTO plan_generation_events(task_id,attempt_id,kind,payload) VALUES (?,?,?,?)').run(taskId, id, kind, JSON.stringify(payload));
  }
  history(taskId: number) {
    return (this.db.query('SELECT * FROM plan_generation_events WHERE task_id=? ORDER BY id').all(taskId) as any[]).map(e => ({ ...e, payload: JSON.parse(e.payload) }));
  }
  private snapshot(taskId: number): PlanSnapshot {
    const task = this.db.query('SELECT name FROM tasks WHERE id=?').get(taskId) as { name: string } | null;
    if (!task) throw Error('Task missing');
    const requirements = this.db.query("SELECT version,content FROM documents WHERE task_id=? AND kind='requirements' ORDER BY version DESC LIMIT 1").get(taskId) as { version: number; content: string } | null;
    if (!requirements) throw Error('Requirements missing');
    const previousPlan = this.db.query("SELECT version,content FROM documents WHERE task_id=? AND kind='plan' ORDER BY version DESC LIMIT 1").get(taskId) as { version: number; content: string } | null;
    const instructions = this.db.query("SELECT id,content FROM messages WHERE task_id=? AND role='user' ORDER BY id").all(taskId) as { id: number; content: string }[];
    // Reviewer findings are evidence of a review, not instructions authored by the user.
    const events = (this.db.query('SELECT id,kind,payload FROM workflow_events WHERE task_id=? ORDER BY id').all(taskId) as any[]).map(e => ({ ...e, payload: JSON.parse(e.payload) }));
    const reviewFeedback = events.filter(e => e.kind === 'review_result'
      && e.payload.status === 'changes_requested' && e.payload.stale === false
      && e.payload.decision?.passed === false && typeof e.payload.decision.feedback === 'string' && e.payload.decision.feedback.trim()
      && Number.isSafeInteger(e.payload.reviewId) && Number.isSafeInteger(e.payload.attemptId)
      && events.some(request => request.kind === 'execution_requested' && request.payload.attemptId === e.payload.attemptId))
      .map(e => ({ eventId: e.id, reviewId: e.payload.reviewId, attemptId: e.payload.attemptId, content: e.payload.decision.feedback }));
    const reviewIssues = events.filter(e => (e.kind === 'review_interrupted' || (e.kind === 'review_result' && ['failed','interrupted','unknown','stale'].includes(e.payload.status)))
      && Number.isSafeInteger(e.payload.reviewId) && Number.isSafeInteger(e.payload.attemptId)
      && events.some(request => request.kind === 'execution_requested' && request.payload.attemptId === e.payload.attemptId))
      .map(e => ({ eventId: e.id, reviewId: e.payload.reviewId, attemptId: e.payload.attemptId, status: e.payload.status }));
    return { taskId, taskName: task.name, instructions, reviewFeedback, reviewIssues, requirements, previousPlan };
  }
  async generate(taskId: number, requestKey: string, adapter: PlanAdapter | undefined, signal = new AbortController().signal) {
    nonempty(requestKey);
    if (!adapter) throw Error('Plan adapter not connected');
    let snapshot!: PlanSnapshot;
    const id = this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM plan_generations WHERE task_id=? AND status IN ('unknown','interrupted') AND acknowledged_by IS NULL").get(taskId)) throw Error('Unknown generation outcome must be acknowledged');
      snapshot = this.snapshot(taskId);
      const id = Number(this.db.query("INSERT INTO plan_generations(task_id,request_key,status,snapshot) VALUES (?,?,'running',?)").run(taskId, requestKey, JSON.stringify(snapshot)).lastInsertRowid);
      this.event(taskId, id, 'started', { requestKey, snapshot });
      return id;
    }).immediate();
    let invoked = false;
    let abort!: () => void;
    let result: { content: string };
    try {
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(Error('cancelled'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      result = await Promise.race([aborted, Promise.resolve().then(() => {
        if (signal.aborted) throw Error('cancelled');
        invoked = true;
        return adapter.generate(structuredClone(snapshot), signal);
      })]);
      result = { content: nonempty(result.content) };
    } catch {
      return this.finish(taskId, id, snapshot, undefined, invoked, signal.aborted ? 'cancelled' : 'generation_failed');
    } finally {
      signal.removeEventListener('abort', abort);
    }
    return this.finish(taskId, id, snapshot, result, false);
  }
  private finish(taskId: number, id: number, snapshot: PlanSnapshot, result?: { content: string }, unknown = false, reason?: string) {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT status FROM plan_generations WHERE id=? AND task_id=?').get(id, taskId) as { status: string } | null;
      if (!row || row.status !== 'running') throw Error('Generation already settled');
      const stale = JSON.stringify(snapshot) !== JSON.stringify(this.snapshot(taskId));
      const status = result ? (stale ? 'stale' : 'adopted') : (unknown ? 'unknown' : 'failed');
      let version: number | undefined;
      if (result && !stale) {
        version = (snapshot.previousPlan?.version ?? 0) + 1;
        this.db.query("INSERT INTO documents(task_id,kind,version,content) VALUES (?,'plan',?,?)").run(taskId, version, result.content);
        const messageId = snapshot.instructions.at(-1)?.id ?? 0;
        this.db.query("INSERT INTO workflow_events(task_id,kind,payload) VALUES (?,'plan',?)").run(taskId, JSON.stringify({ requirementsVersion: snapshot.requirements.version, planVersion: version, messageId }));
      }
      const payload = { status, content: result?.content, version, reason, outcomeUnknown: unknown };
      this.db.query('UPDATE plan_generations SET status=?,result=? WHERE id=?').run(status, JSON.stringify(payload), id);
      this.event(taskId, id, 'settled', payload);
      return { attemptId: id, ...payload };
    }).immediate();
  }
  recover(taskId: number) {
    return this.db.transaction(() => {
      const rows = this.db.query("SELECT id FROM plan_generations WHERE task_id=? AND status='running'").all(taskId) as { id: number }[];
      for (const { id } of rows) {
        this.db.query("UPDATE plan_generations SET status='interrupted' WHERE id=?").run(id);
        this.event(taskId, id, 'interrupted', { outcomeUnknown: true });
      }
      return rows.length;
    }).immediate();
  }
  acknowledge(taskId: number, attemptId: number, actor: string) {
    nonempty(actor);
    return this.db.transaction(() => {
      const update = this.db.query("UPDATE plan_generations SET acknowledged_by=? WHERE id=? AND task_id=? AND status IN ('unknown','interrupted') AND acknowledged_by IS NULL").run(actor, attemptId, taskId);
      if (!update.changes) throw Error('Unacknowledged unknown generation required');
      this.event(taskId, attemptId, 'acknowledged', { actor });
    }).immediate();
  }
}
