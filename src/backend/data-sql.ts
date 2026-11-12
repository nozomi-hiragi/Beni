import { fileURLToPath } from 'node:url';
import type { DataSqlCatalog, DataSqlResult } from '../shared/data-browser';

export const maxSqlBytes = 64 * 1024;
export const maxSqlResponseBytes = 4 * 1024 * 1024;
const maxDurationMs = 3000;
const maxConcurrent = 2;
let running = 0;

const errors = {
  invalid: [400,'DBとSQLの指定を確認してください'],
  missing: [404,'対象のDBが見つかりません'],
  readonly: [400,'読み取り専用のSELECT、WITH、EXPLAINを指定してください'],
  multiple: [400,'SQLは一度に1文だけ実行できます'],
  bindings: [400,'SQLにはパラメーターを指定できません'],
  syntax: [400,'SQLの構文やテーブル名、列名を確認してください'],
  resource: [400,'SQLの処理量が上限を超えました。対象を絞ってください'],
  sqlSize: [413,'SQLは64 KiBまで入力できます'],
  timeout: [408,'SQLの実行が時間切れになりました（3秒）'],
  cancelled: [408,'SQLの実行が中断されました'],
  busy: [429,'SQLを実行中です。少し待ってから再試行してください'],
  unavailable: [500,'DBを読み込めませんでした'],
} as const;
type DataSqlErrorCode = keyof typeof errors;

export class DataSqlError extends Error {
  readonly status: number;
  constructor(readonly code: DataSqlErrorCode) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

export type DataSqlSource = {path: string; root: string; projectId?: string} | {memory: string};
export type DataSqlInput = {source: DataSqlSource; sql?: string};
export type DataSqlSchema = Pick<DataSqlCatalog, 'tables' | 'observedAt'>;
export type DataSqlOutput = {data: DataSqlResult | DataSqlSchema} | {error: DataSqlErrorCode};

export function runDataSql(source: () => DataSqlSource, sql: string, signal?: AbortSignal): Promise<DataSqlResult>;
export function runDataSql(source: () => DataSqlSource, sql: undefined, signal?: AbortSignal): Promise<DataSqlSchema>;
export async function runDataSql(source: () => DataSqlSource, sql: string | undefined, signal?: AbortSignal) {
  if (signal?.aborted) throw new DataSqlError('cancelled');
  if (running >= maxConcurrent) throw new DataSqlError('busy');
  running++;
  try {
    const input: DataSqlInput = {source:source(), sql};
    // Bun Worker の終了要求では SQLite のネイティブ実行を中断できない。
    const child = Bun.spawn([process.execPath,fileURLToPath(new URL('./data-sql-child.ts',import.meta.url))], {
      stdin:Buffer.from(JSON.stringify(input)), stdout:'pipe', stderr:'ignore',
    });
    let interrupted: 'cancelled' | 'timeout' | undefined;
    const stop = (reason: NonNullable<typeof interrupted>) => {
      interrupted ??= reason;
      child.kill('SIGKILL');
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'),maxDurationMs);
    signal?.addEventListener('abort',abort,{once:true});
    try {
      const [output,exitCode] = await Promise.all([new Response(child.stdout).text(),child.exited]);
      if (interrupted) throw new DataSqlError(interrupted);
      if (exitCode !== 0 || Buffer.byteLength(output) > maxSqlResponseBytes + 32) throw new DataSqlError('unavailable');
      const result = JSON.parse(output) as DataSqlOutput;
      if ('error' in result) throw new DataSqlError(result.error);
      return result.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  } catch (error) {
    if (error instanceof DataSqlError) throw error;
    throw new DataSqlError('unavailable');
  } finally {
    running--;
  }
}
