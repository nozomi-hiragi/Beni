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
      const {migrated} = store.migrateProjectDatabases();
      console.log(`プロジェクト DB の移行を確認しました。移行 ${migrated} 件。`);
    } finally { store.close(); }
  } catch (error) {
    const message = error instanceof Error && !('path' in error) ? error.message : '保存ファイルを確認できませんでした';
    console.error(`プロジェクト DB の移行を停止しました。 ${message}`);
    process.exitCode = 1;
  }
}
