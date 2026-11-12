import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { INSTRUCTIONS_CHAT_ID, object, validPack } from '../shared/communication';
import { generateId, validChatId, validProjectId, validTaskId } from '../shared/ids';
import { isTaskPhase, type TaskPhase } from '../shared/task-phase';
import { decodeChatHistory, type StoredConversation } from './chat-history';
import { directory, pathExists, readJson, writeJson } from './data';

export type ChatScope = {projectId:string; taskId:string|null; phase:TaskPhase|null; workflowJobId?:string};
type ChatKind = 'general' | 'task' | 'workflow' | 'instructions';
const kindOf = (scope:ChatScope):ChatKind => scope.workflowJobId !== undefined ? 'workflow' :
  scope.projectId === INSTRUCTIONS_CHAT_ID ? 'instructions' : scope.taskId === null ? 'general' : 'task';

export function chatScopeKey(scope:ChatScope) {
  const {projectId,taskId,phase,workflowJobId} = scope;
  if (!(projectId === INSTRUCTIONS_CHAT_ID || validProjectId(projectId)) ||
      (taskId === null ? phase !== null : !validTaskId(taskId) || !isTaskPhase(phase)) ||
      (projectId === INSTRUCTIONS_CHAT_ID && (taskId !== null || workflowJobId !== undefined)) ||
      (workflowJobId !== undefined && (!workflowJobId || taskId !== null))) throw Error('Invalid chat scope');
  return JSON.stringify([projectId,taskId,phase,workflowJobId ?? null]);
}

type ChatRef = {chatId:string; scopeKey:string; projectId:string; taskId:string|null; phase:TaskPhase|null; workflowJobId:string|null; archived:0|1};
type ChatChange = {scopeKey:string; previousId:string|null; chatId:string; payload:string};
type ChatDeletion = {projectId:string; taskId:string};
const columns = 'chat_id AS chatId,scope_key AS scopeKey,project_id AS projectId,task_id AS taskId,phase,workflow_job_id AS workflowJobId,archived';

export class ChatStore {
  constructor(readonly db:Database, readonly dataDirectory:string) {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chat_refs (
        chat_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, kind TEXT NOT NULL, project_id TEXT NOT NULL,
        task_id TEXT, phase TEXT, workflow_job_id TEXT, archived INTEGER NOT NULL CHECK(archived IN (0,1)));
      CREATE UNIQUE INDEX IF NOT EXISTS chat_current_owner ON chat_refs(scope_key) WHERE archived=0;
      CREATE UNIQUE INDEX IF NOT EXISTS chat_workflow_job ON chat_refs(workflow_job_id) WHERE workflow_job_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS chat_refs_project_task ON chat_refs(project_id,task_id);
      CREATE TABLE IF NOT EXISTS chat_changes (
        scope_key TEXT PRIMARY KEY, previous_id TEXT, chat_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_deletions (
        project_id TEXT NOT NULL, task_id TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id,task_id));
      CREATE TABLE IF NOT EXISTS chat_migration_aliases (
        scope_key TEXT NOT NULL, legacy_id TEXT NOT NULL, chat_id TEXT NOT NULL, PRIMARY KEY(scope_key,legacy_id));`);
  }

  path(chatId:string) {
    if (!validChatId(chatId)) throw Error('Invalid chat ID');
    return join(directory(join(this.dataDirectory,'chats')),chatId+'.json');
  }

  ref(chatId:string) {
    return this.db.query<ChatRef,[string]>(`SELECT ${columns} FROM chat_refs WHERE chat_id=?`).get(chatId);
  }

  current(scope:ChatScope) {
    return this.db.query<ChatRef,[string]>(`SELECT ${columns} FROM chat_refs WHERE scope_key=? AND archived=0`).get(chatScopeKey(scope));
  }

  resolve(scope:ChatScope,id:string) {
    const key = chatScopeKey(scope);
    const direct = this.ref(id);
    if (direct?.scopeKey === key) return direct;
    const alias = this.db.query<{chatId:string},[string,string]>('SELECT chat_id AS chatId FROM chat_migration_aliases WHERE scope_key=? AND legacy_id=?').get(key,id);
    const reference = alias && this.ref(alias.chatId);
    if (reference?.scopeKey === key) return reference;
    if (direct || reference) throw Error('Invalid chat owner');
    return null;
  }

  list(scope:ChatScope) {
    return this.db.query<ChatRef,[string]>(`SELECT ${columns} FROM chat_refs WHERE scope_key=? ORDER BY archived,chat_id`).all(chatScopeKey(scope));
  }

  validate(value:unknown,scope:ChatScope,id?:string) {
    const c = decodeChatHistory(value);
    if (chatScopeKey(c) !== chatScopeKey(scope) ||
        (id !== undefined && (!object(value) || value.chatId !== id || c.id !== id)) ||
        c.packs.some((pack,i)=>!validPack(pack)||pack.sequence!==i+1) ||
        new Set(c.packs.map(pack=>pack.packId)).size!==c.packs.length) throw Error('Invalid history');
    return c;
  }

  publish(scope:ChatScope,chatId:string,archived:boolean) {
    if (!validChatId(chatId)) throw Error('Invalid chat ID');
    this.validate(readJson(this.path(chatId)),scope,chatId);
    const key = chatScopeKey(scope), previous = this.ref(chatId);
    if (previous) {
      if (previous.scopeKey !== key || previous.archived !== Number(archived)) throw Error('Conflicting chat reference');
      return;
    }
    this.db.query('INSERT INTO chat_refs VALUES (?,?,?,?,?,?,?,?)')
      .run(chatId,key,kindOf(scope),scope.projectId,scope.taskId,scope.phase,scope.workflowJobId??null,Number(archived));
  }

  private checkDeletion(scope:ChatScope,confirmedOnly=false) {
    if (this.db.query(`SELECT 1 FROM chat_deletions WHERE project_id=? AND task_id IN ('',?)
      AND (?=0 OR confirmed=1)`).get(scope.projectId,scope.taskId??'',Number(confirmedOnly))) {
      throw Error('Chat owner is being deleted');
    }
  }

  read(scope:ChatScope,id?:string) {
    this.checkDeletion(scope,true);
    const reference = id === undefined ? this.current(scope) : this.resolve(scope,id);
    if (!reference) return;
    return this.readRef(scope,reference.chatId);
  }

  private readRef(scope:ChatScope,chatId:string) {
    const path = this.path(chatId);
    if (!pathExists(path)) throw Error('Missing chat history');
    return this.validate(readJson(path),scope,chatId);
  }

  private change(scope:ChatScope) {
    return this.db.query<ChatChange,[string]>('SELECT scope_key AS scopeKey, previous_id AS previousId, chat_id AS chatId, payload FROM chat_changes WHERE scope_key=?').get(chatScopeKey(scope));
  }

  recover(scope:ChatScope) {
    this.db.transaction(() => {
      const pending = this.change(scope);
      if (!pending) return;
      this.checkDeletion(scope);
      const active = this.current(scope);
      if ((active?.chatId ?? null) !== pending.previousId) throw Error('Conflicting chat operation');
      if (active) this.readRef(scope,active.chatId);
      const value = JSON.parse(pending.payload), path = this.path(pending.chatId);
      this.validate(value,scope,pending.chatId);
      if (pathExists(path)) {
        if (JSON.stringify(readJson(path)) !== pending.payload) throw Error('Conflicting chat file');
      } else writeJson(path,value);
      if (active) this.db.query('UPDATE chat_refs SET archived=1 WHERE chat_id=?').run(active.chatId);
      this.publish(scope,pending.chatId,false);
      this.db.query('DELETE FROM chat_changes WHERE scope_key=?').run(pending.scopeKey);
    }).immediate();
  }

  create(scope:ChatScope,value:(id:string)=>StoredConversation,previousId?:string) {
    const key = chatScopeKey(scope);
    this.db.transaction(() => {
      this.checkDeletion(scope);
      const pending = this.change(scope);
      if (pending) {
        if (previousId !== undefined && pending.previousId !== previousId) throw Error('Conflicting chat operation');
        return;
      }
      const active = this.current(scope);
      if (active && previousId === undefined) return;
      if ((active?.chatId ?? undefined) !== previousId) throw Error('Conflicting chat operation');
      if (active) this.readRef(scope,active.chatId);
      const id = generateId('chat'), payload = JSON.stringify(value(id));
      this.validate(JSON.parse(payload),scope,id);
      this.db.query('INSERT INTO chat_changes VALUES (?,?,?,?)').run(key,previousId??null,id,payload);
    }).immediate();
    this.recover(scope);
    return this.read(scope)!;
  }

  save(scope:ChatScope,value:StoredConversation) {
    this.db.transaction(() => {
      this.checkDeletion(scope);
      const reference = this.current(scope);
      if (reference?.chatId !== value.chatId) throw Error('Conflicting chat reference');
      this.readRef(scope,value.chatId);
      this.validate(value,scope,value.chatId);
      writeJson(this.path(value.chatId),value);
    }).immediate();
  }

  restore(scope:ChatScope,chatId:string) {
    this.db.transaction(() => {
      this.checkDeletion(scope);
      const previous = this.resolve(scope,chatId);
      if (!previous?.archived) throw Error('Invalid archived chat');
      const current = this.current(scope);
      this.readRef(scope,previous.chatId);
      if (current) {
        this.readRef(scope,current.chatId);
        this.db.query('UPDATE chat_refs SET archived=1 WHERE chat_id=?').run(current.chatId);
      }
      this.db.query('UPDATE chat_refs SET archived=0 WHERE chat_id=?').run(previous.chatId);
    }).immediate();
  }

  private deletionRefs(projectId:string,taskId:string|null) {
    return this.db.query<ChatRef,[string,string|null,string|null]>(
      `SELECT ${columns} FROM chat_refs WHERE project_id=? AND (? IS NULL OR task_id=?)`).all(projectId,taskId,taskId);
  }

  prepareDeletion(projectId:string,taskId:string|null) {
    if (!validProjectId(projectId) || (taskId !== null && !validTaskId(taskId))) throw Error('Invalid chat deletion scope');
    this.db.transaction(() => {
      for (const row of this.db.query<{payload:string},[]>('SELECT payload FROM chat_changes').all()) {
        const scope = decodeChatHistory(JSON.parse(row.payload));
        if (scope.projectId === projectId && (taskId === null || scope.taskId === taskId)) this.recover(scope);
      }
      for (const ref of this.deletionRefs(projectId,taskId)) this.readRef({...ref,workflowJobId:ref.workflowJobId??undefined},ref.chatId);
      this.db.query('INSERT INTO chat_deletions(project_id,task_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(projectId,taskId??'');
    }).immediate();
  }

  cancelDeletion(projectId:string,taskId:string|null) {
    this.db.query('DELETE FROM chat_deletions WHERE project_id=? AND task_id=? AND confirmed=0').run(projectId,taskId??'');
  }

  finishDeletion(projectId:string,taskId:string|null) {
    const mark = this.db.query('UPDATE chat_deletions SET confirmed=1 WHERE project_id=? AND task_id=?').run(projectId,taskId??'');
    if (!mark.changes) throw Error('Missing chat deletion record');
    this.db.transaction(() => {
      for (const ref of this.deletionRefs(projectId,taskId)) {
        const path = this.path(ref.chatId);
        if (pathExists(path)) {
          this.readRef({...ref,workflowJobId:ref.workflowJobId??undefined},ref.chatId);
          unlinkSync(path);
        }
        this.db.query('DELETE FROM chat_migration_aliases WHERE chat_id=?').run(ref.chatId);
        this.db.query('DELETE FROM chat_refs WHERE chat_id=?').run(ref.chatId);
      }
      this.db.query('DELETE FROM chat_deletions WHERE project_id=? AND task_id=?').run(projectId,taskId??'');
    }).immediate();
  }

  recoverDeletions(ownerExists:(projectId:string,taskId:string|null)=>boolean|undefined) {
    for (const pending of this.db.query<ChatDeletion & {confirmed:0|1},[]>('SELECT project_id AS projectId,task_id AS taskId,confirmed FROM chat_deletions').all()) {
      const taskId = pending.taskId || null;
      const exists = pending.confirmed ? false : ownerExists(pending.projectId,taskId);
      if (exists === false) this.finishDeletion(pending.projectId,taskId);
      else if (exists === true) this.cancelDeletion(pending.projectId,taskId);
    }
  }
}
