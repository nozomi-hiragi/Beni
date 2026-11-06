import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export type DocumentSource = {
  kind: 'document' | 'instruction' | 'message' | 'result' | 'template' | 'legacy';
  id: string;
  revision?: string;
  start?: number;
  text: string;
};

export type DocumentItemInput = {
  id?: string;
  text: string;
  reason: string;
  sources: DocumentSource[];
};

type DocumentItem = DocumentItemInput & { id: string };

export type DocumentSeed = {
  kind: 'template' | 'legacy';
  reason: string;
  sourceText?: string;
};

export type DocumentVersion = {
  name: string;
  revision: string;
  content: string;
  updatedAt: number;
  items: DocumentItem[];
};

type VersionRow = {
  name: string;
  revision: string;
  updated_at: number;
  items_json: string;
};

const maxDocumentBytes = 1024 * 1024;
const maxSnapshotBytes = 8 * maxDocumentBytes;
const maxItems = 1024;
const maxSources = 32;
const maxReasonBytes = 16 * 1024;
const maxSourceBytes = 64 * 1024;
const sourceKinds = new Set(['document', 'instruction', 'message', 'result', 'template', 'legacy']);

export class DocumentConflictError extends Error {
  constructor() {
    super('文書の版が更新されています。最新の版を取得してください。');
    this.name = 'DocumentConflictError';
  }
}

export class DocumentTable {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_versions (
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        revision TEXT NOT NULL,
        items_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        actor TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, name, revision)
      );
      CREATE TABLE IF NOT EXISTS document_heads (
        scope TEXT NOT NULL,
        name TEXT NOT NULL,
        revision TEXT NOT NULL,
        PRIMARY KEY (scope, name),
        FOREIGN KEY (scope, name, revision) REFERENCES document_versions (scope, name, revision)
      );
    `);
  }

  list(scope: string): DocumentVersion[] {
    requireIdentifier(scope);
    return this.db.query<VersionRow, [string]>(`
      SELECT version.name, version.revision, version.updated_at, version.items_json
      FROM document_heads AS head
      JOIN document_versions AS version USING (scope, name, revision)
      WHERE head.scope = ?
      ORDER BY head.name
    `).all(scope).map(readVersion);
  }

  get(scope: string, name: string, revision?: string): DocumentVersion | undefined {
    requireIdentifier(scope);
    requireIdentifier(name);
    if (revision !== undefined) requireIdentifier(revision);

    const row = this.db.query<VersionRow, [string, string, string | null]>(`
      SELECT name, revision, updated_at, items_json
      FROM document_versions
      WHERE scope = ?1 AND name = ?2
        AND revision = coalesce(?3, (SELECT revision FROM document_heads WHERE scope = ?1 AND name = ?2))
    `).get(scope, name, revision ?? null);
    return row ? readVersion(row) : undefined;
  }

  history(scope: string): DocumentVersion[] {
    requireIdentifier(scope);
    return this.db.query<VersionRow, [string]>(`
      SELECT name, revision, updated_at, items_json
      FROM document_versions
      WHERE scope = ?
      ORDER BY rowid
    `).all(scope).map(readVersion);
  }

  replay(scope: string, name: string, actor: string): DocumentVersion | undefined {
    requireIdentifier(scope);
    requireIdentifier(name);
    requireIdentifier(actor);
    const row = this.db.query<VersionRow, [string, string, string]>(`
      SELECT name, revision, updated_at, items_json
      FROM document_versions
      WHERE scope = ? AND name = ? AND actor = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(scope, name, actor);
    return row ? readVersion(row) : undefined;
  }

  seed(scope: string, name: string, content: string, seed: DocumentSeed): DocumentVersion {
    requireIdentifier(scope);
    requireIdentifier(name);
    requireString(content, maxDocumentBytes);
    return this.db.transaction(() => {
      const existing = this.get(scope, name);
      if (existing) return existing;
      // 区切りの空行も保持し、項目数の上限を超える既存文書は一項目に取り込む。
      const blocks = content.split(/(\r?\n(?:[\t ]*\r?\n)+)/).filter(Boolean);
      const texts = blocks.length <= maxItems ? blocks : [content];
      const items = texts.map(text => {
        const id = randomUUID();
        if (!text.trim()) return { id, text, reason: '', sources: [] };
        const excerpt = (seed.sourceText ?? text).trim().slice(0, 256).replace(/[\ud800-\udbff]$/, '');
        return { id, text, reason: seed.reason, sources: [{ kind: seed.kind, id: name, text: excerpt }] };
      });
      return this.save(scope, name, null, items, seed.kind === 'legacy' ? 'migration' : 'template');
    }).immediate();
  }

  update(scope: string, name: string, base: string | null, items: DocumentItemInput[], actor: string): DocumentVersion {
    requireIdentifier(scope);
    requireIdentifier(name);
    requireIdentifier(actor);
    if (base !== null) requireIdentifier(base);
    if (!Array.isArray(items) || items.length > maxItems) {
      throw new Error('文書の項目数が上限を超えているか、形式が無効です。');
    }
    return this.db.transaction(() => {
      const current = this.get(scope, name);
      if ((current?.revision ?? null) !== base) throw new DocumentConflictError();
      const existing = new Map(current?.items.map(item => [item.id, item]));
      const seen = new Set<string>();
      let contentBytes = 0;
      let snapshotBytes = 2;
      const next = Array.from(items, input => {
        const item = validateItem(input, existing, seen);
        contentBytes += Buffer.byteLength(item.text);
        snapshotBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
        if (contentBytes > maxDocumentBytes || snapshotBytes > maxSnapshotBytes) {
          throw new Error('文書または根拠のサイズが上限を超えています。');
        }
        return item;
      });
      return this.save(scope, name, base, next, actor);
    }).immediate();
  }

  private save(scope: string, name: string, base: string | null, items: DocumentItem[], actor: string): DocumentVersion {
    const revision = randomUUID();
    const updatedAt = Math.max(Date.now(), base ? (this.get(scope, name, base)?.updatedAt ?? 0) + 1 : 0);
    const content = items.map(item => item.text).join('');
    this.db.run(`
      INSERT INTO document_versions (scope, name, revision, items_json, content_hash, actor, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [scope, name, revision, JSON.stringify(items), createHash('sha256').update(content).digest('hex'), actor, updatedAt]);

    const result = base === null
      ? this.db.run('INSERT INTO document_heads (scope, name, revision) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [scope, name, revision])
      : this.db.run('UPDATE document_heads SET revision = ? WHERE scope = ? AND name = ? AND revision = ?', [revision, scope, name, base]);
    if (result.changes !== 1) throw new DocumentConflictError();
    return { name, revision, content, updatedAt, items };
  }
}

function readVersion(row: VersionRow): DocumentVersion {
  const items = JSON.parse(row.items_json) as DocumentItem[];
  return {
    name: row.name,
    revision: row.revision,
    content: items.map(item => item.text).join(''),
    updatedAt: row.updated_at,
    items,
  };
}

function validateItem(input: DocumentItemInput, existing: Map<string, DocumentItem>, seen: Set<string>): DocumentItem {
  if (!input || typeof input !== 'object') throw new Error('文書項目の形式が無効です。');
  const { id, text, reason, sources } = input;
  const previous = id === undefined ? undefined : existing.get(id);
  if (id !== undefined && (!previous || seen.has(id))) {
    throw new Error('文書に存在しないか、重複する項目IDです。');
  }
  if (id !== undefined) seen.add(id);
  requireString(text, maxDocumentBytes);
  requireString(reason, maxReasonBytes);
  if (!Array.isArray(sources) || sources.length > maxSources) {
    throw new Error('参照元の件数が上限を超えているか、形式が無効です。');
  }
  const references = Array.from(sources, validateSource);
  if (previous && previous.text === text && previous.reason === reason
    && JSON.stringify(previous.sources) === JSON.stringify(references)) return previous;
  if (references.some(source => source.kind === 'template' || source.kind === 'legacy')) {
    throw new Error('初期設定や既存文書から取り込んだ項目を引用するときは、文書の版と項目を指定してください。');
  }
  if (text.trim() && (!reason.trim() || references.length === 0)) {
    throw new Error('見出しや本文の追加・変更には採用理由と参照元が必要です。');
  }
  return { id: id ?? randomUUID(), text, reason, sources: references };
}

function validateSource(source: DocumentSource): DocumentSource {
  if (!source || typeof source !== 'object' || !sourceKinds.has(source.kind)) {
    throw new Error('参照元の形式が無効です。');
  }
  const { kind, id, revision, start, text } = source;
  requireIdentifier(id);
  if (revision !== undefined) requireIdentifier(revision);
  requireString(text, maxSourceBytes);
  if (!text.trim()) throw new Error('参照元の原文が空です。');
  if (start !== undefined && (!Number.isSafeInteger(start) || start < 0)) throw Error('引用位置が無効です。');
  return { kind, id, revision, ...(start === undefined ? {} : {start}), text };
}

function requireIdentifier(value: unknown): asserts value is string {
  requireString(value, 4096);
  if (!value.trim() || value.includes('\0')) throw new Error('識別子が無効です。');
}

function requireString(value: unknown, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) {
    throw new Error('文字列のサイズが上限を超えているか、形式が無効です。');
  }
}
