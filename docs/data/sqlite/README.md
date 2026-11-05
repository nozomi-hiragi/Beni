# SQLite

保存仕様を定義します。

Beni 自身に属するプロジェクトの登録情報・保存先への対応と、アプリ共通のインストラクションを扱います。

## DB構成

アプリ側SQLiteには `projects` と `instructions` を持ちます。タスクの検索索引は追加しません。

```text
beni.sqlite
├── projects
│   ├── id       プロジェクトの識別子
│   ├── name     project.jsonの表示名のコピー
│   └── folder   プロジェクトの保存先
└── instructions
    ├── key      全共通・フェーズ・編集相談用のキー
    └── content  Markdownの指示テンプレート
```

`id` はTEXTで保存し、[共通ID規則](../README.md#idの共通規則)のプロジェクト用ID（第3グループ `7000`）を使います。`.beni/project.json` の `id` を正本とし、同じ値を登録します。JSONカラムは追加しません。名前の正本も `project.json` とし、`projects.name` は一覧表示用のコピーとして同期します。

タスク情報・文書・会話の正本は、対象プロジェクト直下の `.beni` に置きます。アプリ側に `tasks`・`messages`・`documents` テーブルは持ちません。保存形式は [プロジェクトの .beni](../beni/README.md) で定義します。

プロジェクト・タスク・会話・文書の参照は、保存先の変更や再登録でも混同しないように設計します。移動・再登録ではプロジェクトIDを維持します。

[データ設計の全体像](../README.md)

インストラクションの初期登録・変数・利用方法は [インストラクション管理](../../features/instructions.md) を参照してください。
