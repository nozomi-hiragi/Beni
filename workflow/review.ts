import { Database } from 'bun:sqlite';
import { outcomeState } from './outcome';

export interface ReviewSnapshot {
  taskId: number;
  attemptId: number;
  approvalId: number;
  messageId: number;
  generationIds: { requirements: number; plan: number };
  requirements: { version: number; content: string };
  plan: { version: number; content: string };
  execution: { output: string; evidence: string[] };
}
export interface ReviewDecision { passed: boolean; feedback: string }
export interface Reviewer { review(snapshot: Readonly<ReviewSnapshot>, signal: AbortSignal): Promise<ReviewDecision> }
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Review records are durable. Reopening never invokes a reviewer or repeats a review. */
export class ExecutionReview {
  private db: Database;
  constructor(path: string, private sync: (taskId: number) => void = () => {}) {
    this.db = new Database(path);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS execution_reviews(id INTEGER PRIMARY KEY,task_id INTEGER NOT NULL REFERENCES tasks(id),attempt_id INTEGER NOT NULL UNIQUE REFERENCES execution_attempts(id),status TEXT NOT NULL,snapshot TEXT NOT NULL,result TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_review ON execution_reviews(task_id) WHERE status='running';`);
  }
  close() { this.db.close(); }
  history(taskId: number) {
    return (this.db.query('SELECT * FROM execution_reviews WHERE task_id=? ORDER BY id').all(taskId) as any[]).map(r => ({ ...r, snapshot: JSON.parse(r.snapshot), result: r.result ? JSON.parse(r.result) : null }));
  }
  private snapshot(taskId: number, attemptId: number): ReviewSnapshot {
    const generation = (table: 'requirement_generations' | 'plan_generations') => {
      if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return 0;
      if (this.db.query(`SELECT 1 FROM ${table} WHERE task_id=? AND status='running'`).get(taskId)) throw Error('Generation still running');
      if (this.db.query(`SELECT 1 FROM ${table} WHERE task_id=? AND status IN ('unknown','interrupted') AND acknowledged_by IS NULL`).get(taskId)) throw Error('Generation outcome must be acknowledged');
      return (this.db.query(`SELECT COALESCE(MAX(id),0) AS id FROM ${table} WHERE task_id=?`).get(taskId) as {id:number}).id;
    };
    const generationIds = { requirements: generation('requirement_generations'), plan: generation('plan_generations') };
    const events = (this.db.query('SELECT id,kind,payload FROM workflow_events WHERE task_id=? ORDER BY id').all(taskId) as any[]).map(e => ({ ...e, payload: JSON.parse(e.payload) }));
    const requested = events.find(e => e.kind === 'execution_requested' && e.payload.attemptId === attemptId);
    const result = events.find(e => e.kind === 'execution_result' && e.payload.attemptId === attemptId);
    const attempt = this.db.query('SELECT status FROM execution_attempts WHERE id=? AND task_id=?').get(attemptId, taskId) as any;
    const latest = this.db.query('SELECT id FROM execution_attempts WHERE task_id=? ORDER BY id DESC LIMIT 1').get(taskId) as any;
    if (!requested || !result || attempt?.status !== 'succeeded' || latest?.id !== attemptId || result.payload.status !== 'succeeded' || result.payload.stale !== false) throw Error('Current successful execution required');
    const execution = result.payload.result;
    if (!nonempty(execution?.output) || !Array.isArray(execution.evidence) || !execution.evidence.length || !execution.evidence.every(nonempty)) throw Error('Saved evidence required');
    // Unknown execution outcomes cannot be turned into an approved result by
    // reviewing their apparent output. Reject malformed flags as well.
    if (outcomeState(execution) !== 'known') throw Error('Execution outcome must be confirmed');
    const approval = events.filter(e => e.kind === 'approval').at(-1);
    const document = (kind: string) => this.db.query('SELECT version,content FROM documents WHERE task_id=? AND kind=? ORDER BY version DESC LIMIT 1').get(taskId, kind) as {version:number;content:string} | null;
    const requirements = document('requirements'), plan = document('plan');
    const messageId = (this.db.query("SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE task_id=? AND role='user'").get(taskId) as any).id;
    if (!requirements || !plan || !approval || approval.id !== requested.payload.approvalId || approval.payload.messageId !== messageId || requested.payload.messageId !== messageId || approval.payload.requirementsVersion !== requirements.version || approval.payload.planVersion !== plan.version || JSON.stringify(requested.payload.request.requirements) !== JSON.stringify(requirements) || JSON.stringify(requested.payload.request.plan) !== JSON.stringify(plan)) throw Error('Execution approval is stale');
    return { taskId, attemptId, approvalId: approval.id, messageId, generationIds, requirements, plan, execution: structuredClone(execution) };
  }
  async review(taskId: number, attemptId: number, reviewer: Reviewer | undefined, signal = new AbortController().signal) {
    if (!reviewer) throw Error('Reviewer not connected');
    this.sync(taskId);
    let snapshot!: ReviewSnapshot;
    const id = this.db.transaction(() => {
      snapshot = this.snapshot(taskId, attemptId);
      return Number(this.db.query("INSERT INTO execution_reviews(task_id,attempt_id,status,snapshot) VALUES (?,?,'running',?)").run(taskId, attemptId, JSON.stringify(snapshot)).lastInsertRowid);
    }).immediate();
    let abort!: () => void;
    let decision: ReviewDecision | undefined;
    let reason: string | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => { abort = () => reject(Error('cancelled')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); });
      const result = await Promise.race([cancelled, Promise.resolve().then(() => { if (signal.aborted) throw Error('cancelled'); return reviewer.review(freeze(structuredClone(snapshot)), signal); })]);
      if (typeof result?.passed !== 'boolean' || !nonempty(result.feedback)) throw Error('Review decision and feedback required');
      decision = { passed: result.passed, feedback: result.feedback };
    } catch { reason = signal.aborted ? 'cancelled' : 'review_failed'; }
    finally { signal.removeEventListener('abort', abort); }
    this.sync(taskId);
    return this.db.transaction(() => {
      const row = this.db.query('SELECT status,snapshot FROM execution_reviews WHERE id=?').get(id) as any;
      if (row.status !== 'running') throw Error('Review already settled');
      let stale = false;
      try { stale = row.snapshot !== JSON.stringify(this.snapshot(taskId, attemptId)); } catch { stale = true; }
      const status = stale ? 'stale' : !decision ? 'failed' : decision.passed ? 'completed' : 'changes_requested';
      const result = { status, decision, reason, stale };
      this.db.query('UPDATE execution_reviews SET status=?,result=? WHERE id=?').run(status, JSON.stringify(result), id);
      this.db.query("INSERT INTO workflow_events(task_id,kind,payload) VALUES (?,'review_result',?)").run(taskId, JSON.stringify({ reviewId: id, attemptId, ...result }));
      return { reviewId: id, attemptId, ...result };
    }).immediate();
  }
  recover(taskId: number) {
    return this.db.transaction(() => {
      const rows = this.db.query("SELECT id,attempt_id FROM execution_reviews WHERE task_id=? AND status='running'").all(taskId) as any[];
      for (const row of rows) {
        const result = { status: 'interrupted', outcomeUnknown: true };
        this.db.query('UPDATE execution_reviews SET status=?,result=? WHERE id=?').run('interrupted', JSON.stringify(result), row.id);
        this.db.query("INSERT INTO workflow_events(task_id,kind,payload) VALUES (?,'review_interrupted',?)").run(taskId, JSON.stringify({ reviewId: row.id, attemptId: row.attempt_id, ...result }));
      }
      return rows.length;
    }).immediate();
  }
}
