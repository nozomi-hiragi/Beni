import { DatabaseSync, constants, type SQLOutputValue } from 'node:sqlite';
import { dirname, join } from 'node:path';
import type { DataSqlResult, DataSqlValue } from '../shared/data-browser';
import { directoryStat, openDataDatabase } from './data-browser-files';
import { DataSqlError, maxSqlResponseBytes, type DataSqlInput, type DataSqlOutput, type DataSqlSchema, type DataSqlSource } from './data-sql';

const maxRows = 500;
const maxCellBytes = 64 * 1024;
const sqliteValueLimit = 16 * 1024 * 1024;
const sqliteHeapLimit = 128 * 1024 * 1024;
const options = {
  readOnly:true,
  allowExtension:false,
  enableForeignKeyConstraints:false,
  limits:{length:sqliteValueLimit, variableNumber:0, attach:0},
};
// SQLite と同じく行コメントは LF で終わり、末尾まで続くブロックコメントも空白扱いになる。
const leadingTrivia = /^(?:[\t\n\f\r \uFEFF]+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))+/;
const trimTrivia = (sql: string) => sql.replace(leadingTrivia,'');

function open(source: DataSqlSource) {
  if ('memory' in source) {
    const db = new DatabaseSync(':memory:',options);
    try {
      db.deserialize(Buffer.from(source.memory,'base64'));
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  directoryStat(source.root);
  if (source.projectId) directoryStat(join(source.root,'projects'));
  if (dirname(source.path) !== (source.projectId ? join(source.root,'projects') : source.root)) throw new DataSqlError('unavailable');
  return openDataDatabase(source.path,path => {
    const db = new DatabaseSync(path,options);
    // SQLite がファイルを開く時点でリンクへ置き換わっていないことも確認する。
    if (db.location() !== path) {
      db.close();
      throw new DataSqlError('unavailable');
    }
    return db;
  });
}

function schema(db: DatabaseSync): DataSqlSchema {
  const rows = db.prepare(`
    SELECT 'sqlite_schema' AS name, 'table' AS type, NULL AS sql
    UNION ALL
    SELECT name,type,sql FROM main.sqlite_schema WHERE type IN ('table','view')
    ORDER BY name
  `).iterate() as Iterable<{name:string; type:string; sql:string|null}>;
  const tables: DataSqlSchema['tables'] = [];
  let bytes = 0;
  for (const row of rows) {
    const identifier = '"' + row.name.replaceAll('"','""') + '"';
    const columns = db.prepare(`PRAGMA main.table_xinfo(${identifier})`).all().map(column => ({
      name:column.name as string, type:column.type as string, notnull:column.notnull === 1, pk:Number(column.pk) > 0,
    }));
    const table = {...row,columns};
    bytes += Buffer.byteLength(JSON.stringify(table)) + 1;
    if (bytes + 256 > maxSqlResponseBytes) throw new DataSqlError('resource');
    tables.push(table);
  }
  return {tables,observedAt:new Date().toISOString()};
}

function cell(value: SQLOutputValue): DataSqlValue {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : {type:'integer', value:String(value)};
  }
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value);
    if (bytes <= maxCellBytes) return value;
    const buffer = Buffer.from(value);
    let end = maxCellBytes;
    while ((buffer[end] & 0xc0) === 0x80) end--;
    return {type:'text',value:buffer.toString('utf8',0,end),bytes,truncated:true};
  }
  const bytes = value.byteLength;
  const hex = Buffer.from(value.buffer,value.byteOffset,Math.min(bytes,maxCellBytes)).toString('hex');
  return {type:'blob',hex,bytes,...(bytes > maxCellBytes && {truncated:true})};
}

function execute(db: DatabaseSync, sql: string): DataSqlResult {
  const start = performance.now();
  const firstWord = /^([a-z]+)\b/i;
  let head = trimTrivia(sql);
  if (sql.includes('\0') || !head) throw new DataSqlError('syntax');
  const keyword = head.match(firstWord)?.[1].toUpperCase();
  if (keyword === 'EXPLAIN') {
    head = trimTrivia(head.slice('EXPLAIN'.length));
    if (/^QUERY\b/i.test(head)) {
      head = trimTrivia(head.slice('QUERY'.length));
      if (!/^PLAN\b/i.test(head)) throw new DataSqlError('syntax');
      head = trimTrivia(head.slice('PLAN'.length));
    }
  }
  if (!/^(SELECT|WITH)\b/i.test(head)) throw new DataSqlError('readonly');
  db.setAuthorizer((action, _target, operation) => {
    switch (action) {
      case constants.SQLITE_SELECT:
      case constants.SQLITE_READ:
      case constants.SQLITE_RECURSIVE:
        return constants.SQLITE_OK;
      case constants.SQLITE_FUNCTION:
        return ['load_extension','fts3_tokenizer','readfile','writefile','edit'].includes(operation?.toLowerCase() ?? '')
          ? constants.SQLITE_DENY : constants.SQLITE_OK;
      default:
        return constants.SQLITE_DENY;
    }
  });
  try {
    const statement = db.prepare(sql);
    // SQLite 自身が切り出した文の終端以降には、空白とコメントのみを許す。
    if (!sql.startsWith(statement.sourceSQL) || trimTrivia(sql.slice(statement.sourceSQL.length))) {
      throw new DataSqlError('multiple');
    }
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const columns = statement.columns().map(column => column.name);
    const rows: DataSqlValue[][] = [];
    let bytes = Buffer.byteLength(JSON.stringify(columns)) + 256;
    if (bytes > maxSqlResponseBytes) throw new DataSqlError('resource');
    let truncated = false;
    for (const values of statement.iterate() as unknown as Iterable<SQLOutputValue[]>) {
      if (rows.length === maxRows) { truncated = true; break; }
      const row = values.map(cell);
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > maxSqlResponseBytes) { truncated = true; break; }
      if (row.some(value => value !== null && typeof value === 'object' && 'truncated' in value)) truncated = true;
      rows.push(row);
    }
    return {columns,rows,truncated,elapsedMs:Math.round(performance.now() - start),observedAt:new Date().toISOString()};
  } catch (error) {
    if (error instanceof DataSqlError) throw error;
    const {errcode,message} = error as {errcode?:number; message?:string};
    if (errcode === 23 || errcode === 8) throw new DataSqlError('readonly');
    if (errcode === 1 && message === 'too many SQL variables') throw new DataSqlError('bindings');
    if (errcode === 7 || errcode === 18) throw new DataSqlError('resource');
    if (errcode === 1) throw new DataSqlError('syntax');
    throw new DataSqlError('unavailable');
  }
}

function run({source,sql}: DataSqlInput): DataSqlOutput {
  try {
    const db = open(source);
    try {
      db.exec(`PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA query_only=ON; PRAGMA hard_heap_limit=${sqliteHeapLimit}; BEGIN;`);
      if ('projectId' in source && source.projectId) {
        const identity = db.prepare(`
          SELECT singleton,project_id FROM main.project_identity
          WHERE EXISTS (SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='project_identity')
          LIMIT 2
        `).all();
        if (identity.length !== 1 || identity[0].singleton !== 1 || identity[0].project_id !== source.projectId) {
          throw new DataSqlError('unavailable');
        }
      }
      return {data:sql === undefined ? schema(db) : execute(db,sql)};
    } finally {
      db.close();
    }
  } catch (error) {
    return {error:error instanceof DataSqlError ? error.code : 'unavailable'};
  }
}

export async function runDataSqlChild() {
  const result = run(await Bun.stdin.json() as DataSqlInput);
  process.stdout.write(JSON.stringify(result));
}

if (import.meta.main && !Bun.isStandaloneExecutable) await runDataSqlChild();
