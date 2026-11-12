import { lstatSync } from 'node:fs';
import { dataPaths } from './server';
import { migrateChatStorage } from './chat-migration';
import { Store } from './store';

if (import.meta.main) {
  try {
    const {database, dataDirectory} = dataPaths();
    const info = lstatSync(database);
    if (!info.isFile() || info.nlink !== 1) throw Error('Invalid Beni database file');
    const store = new Store(database, {migration: true});
    try {
      const result = migrateChatStorage(store.chats, dataDirectory, store.chatMigrationProjects(true));
      console.log(`チャット移行を確認しました。会話 ${result.chats} 件、旧ファイル削除 ${result.removed} 件。`);
    } finally { store.close(); }
  } catch (error) {
    // ファイルシステムの例外に含まれる保存パスは出力しない。
    const message = error instanceof Error && !('path' in error) ? error.message : '保存ファイルを確認できませんでした';
    console.error(`チャット移行を停止しました。 ${message}`);
    process.exitCode = 1;
  }
}
