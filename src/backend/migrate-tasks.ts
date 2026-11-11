import { lstatSync } from 'node:fs';
import { dataPaths } from './server';
import { Store } from './store';

if (import.meta.main) {
  try {
    const {database} = dataPaths();
    const info = lstatSync(database);
    if (!info.isFile() || info.nlink !== 1) throw Error('Invalid Beni database file');
    const store = new Store(database, {migration: true});
    try {
      const result = store.migrateTasks();
      console.log(`タスク移行を確認しました。タスク ${result.migrated} 件、旧JSON削除 ${result.removed} 件。`);
    } finally { store.close(); }
  } catch (error) {
    const message = error instanceof Error && !('path' in error) ? error.message : '保存ファイルを確認できませんでした';
    console.error(`タスク移行を停止しました。 ${message}`);
    process.exitCode = 1;
  }
}
