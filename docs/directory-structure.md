# ディレクトリ構成

Beni は一つのアプリケーションとして管理し、サーバー側を `src/backend/`、ブラウザー側を `src/frontend/`、共通の通信定義を `src/shared/` に分けています。設定ファイルはルート、テストは対象コードの近くに置きます。

`[生成]` と `[データ]` は Git 管理の対象外です。テストファイルは一部を `*.test.tsx` としてまとめています。

```text
Beni/
├── src/                              アプリケーションのコード
│   ├── backend/                      Bun で動くサーバー側の処理
│   │   ├── server.ts                 サーバー起動、API、フロントエンド配信、保存先設定
│   │   ├── server.test.ts            API・配信・文書管理・変更通知・保存先のテスト
│   │   ├── chat.ts                   エージェント通信、会話の保存・再開・受信・中断
│   │   ├── claude.ts                 Claude Code CLI の状態確認とストリーム変換
│   │   ├── claude.test.ts            Claude の受信・権限設定・中断・接続失敗のテスト
│   │   ├── chat.test.ts              会話の保存・再開・中断・分離、接続エラーのテスト
│   │   ├── data.ts                   メタデータ検証・保存と文書だけ残ったタスクの復元
│   │   ├── documents.ts              タスク用 Markdown の作成・読み取り・変更監視
│   │   ├── task-history.ts           タスクの変更イベント・文書の版・履歴取得
│   │   ├── terminal.ts               PTY・端末画面・操作権・終了処理
│   │   ├── terminal.test.ts          シェルの存続・排他・画面復元・HTTP/WSのテスト
│   │   ├── events.ts                 共通 WS の接続・購読・送信上限と解放処理
│   │   ├── store/                    データベースへのアクセス
│   │   │   ├── index.ts              SQLiteの登録情報とプロジェクト内のタスク管理
│   │   │   └── index.test.ts         メタデータ・復元のテスト
│   │   └── test/                     バックエンドのテスト補助
│   │       ├── fake-codex.ts          実サービスを使わず Codex 通信を模擬する実行ファイル
│   │       └── fake-claude.ts         実サービスを使わず Claude 通信を模擬する実行ファイル
│   ├── shared/                       FE・BE 共通の通信定義
│   │   ├── ids.ts                    プロジェクト・タスクIDの生成と種別検証
│   │   ├── task-phase.ts             共通のフェーズ識別子と検証
│   │   └── communication.ts          パック・WS メッセージの型、受信検証、ハッシュ
│   └── frontend/                     ブラウザーで動く SolidJS の画面
│       ├── index.html                アプリの表示先と JavaScript・CSS の読み込み
│       ├── main.tsx                  SolidJS のアプリを HTML に取り付ける入口
│       ├── App.tsx                   URL に応じたホーム・設定・プロジェクト画面の切り替え
│       ├── Home.tsx                  プロジェクト・タスク作成、タスク一覧の検索・並べ替え
│       ├── Workspace.tsx             チャット・タスク・文書の表示とタブ管理
│       ├── api.ts                    バックエンドへの JSON リクエストとエラー処理
│       ├── model-cache.ts            接続先別モデル一覧・フェーズ別チャットモデル・タスク別実装モデルの記憶
│       ├── communication.ts          共通 WS、購読の共有、再接続
│       ├── chat-sync.ts              チャットのパック照合・順序付き確定・再同期
│       ├── chat-scroll.ts            最下部にいる間のスクロール追従
│       ├── assets.d.ts               CSS importの型宣言
│       ├── types.ts                  プロジェクト・タスク・文書・会話などの型
│       ├── tailwind.css              Tailwind CSS の探索対象、daisyUI のテーマ、共通スタイル
│       ├── *.test.tsx                画面の表示・操作のテスト
│       ├── test-events.ts            WS とパックを模擬するテスト補助
│       └── components/               画面を構成する部品
│           ├── ResizeHandle.tsx      作業領域の左右・上下比率を調整するハンドル
│           ├── TerminalPanel.tsx     ターミナルタブ・描画・操作権・再接続
│           ├── MarkdownPreview.tsx   Markdown の変換・サニタイズ・装飾表示
│           ├── Menu.tsx              ホーム・設定への移動と検索のメニュー
│           ├── TaskCreate.tsx        プロジェクトを選び、タスクを作成するフォーム
│           ├── TaskList.tsx          タスク一覧と並べ替え操作
│           ├── ProjectCreateDialog.tsx  プロジェクトの名前・フォルダーを指定するダイアログ
│           ├── FolderPicker.tsx      バックエンドが動く環境のフォルダー選択
│           ├── ChatPanel.tsx         Codex との会話、モデル選択、送信・中断、過去の履歴表示
│           ├── CodexSettings.tsx     Codex のインストール・認証・モデルなどの状態確認
│           ├── ChatComposer.tsx      テキスト入力と送信フォーム
│           ├── PhaseIndicator.tsx    フェーズ表示と実装開始・停止・タスク完了・再開
│           ├── TabBar.tsx            タブの選択と閉じる操作
│           ├── TreeView.tsx          項目の階層表示と選択
│           └── *.test.tsx            部品の表示・操作のテスト
├── dist/                             [生成] ビルド出力
│   ├── shared/                       FE・BE 共通の通信定義
│   │   └── communication.ts          パック・WS メッセージの型、受信検証、ハッシュ
│   └── frontend/                     フロントエンドの生成物
│       ├── app.js                    Vite が生成する JavaScript
│       ├── beni.css                  xterm.js のスタイル
│       └── generated.css             Tailwind CSS・daisyUI が生成する CSS
├── docs/                             仕様書、画面モック、構成の説明
│   ├── README.md                     ドキュメントの目次
│   ├── directory-structure.md        この文書
│   ├── data/                         データの仕様
│   │   ├── README.md                 保存責任・正本・データの関係
│   │   ├── sqlite/                   SQLite の仕様
│   │   │   └── README.md             保存責任と参照の方針
│   │   └── beni/                     プロジェクト内データの仕様
│   │       ├── README.md             文書の正本と復元の方針
│   │       └── chat.md               .beni/chat の会話保存仕様
│   ├── communication/                通信仕様
│   │   ├── README.md                 方針と文書の目次
│   │   ├── http-api.md               HTTP API とパック同期の契約
│   │   ├── websocket.md              WS の接続・購読・メッセージ仕様
│   │   ├── terminal.md               ターミナルの操作権・画面復元・入出力
│   │   └── chat-sync.md              チャットのパック確定・再接続時の同期
│   ├── next-agent-plan.md            アプリ全体の目的、利用の流れ、構想
│   ├── screens/                      画面ごとの仕様
│   │   ├── home.md                   ホーム画面
│   │   ├── project-detail.md         プロジェクト詳細画面
│   │   ├── project-settings.md       プロジェクト設定・作成
│   │   └── settings.md               設定画面
│   ├── objects/                      オブジェクト仕様
│   │   ├── README.md                 目次と各要素の関係
│   │   ├── project.md                プロジェクトの持ち物と操作
│   │   ├── task.md                   タスクと文書
│   │   ├── chat.md                   会話・発言・返信パック
│   │   ├── task-events.md            フェーズ間の変更履歴と文書の版
│   │   └── terminal.md               ターミナルとシェル
│   ├── features/                     機能ごとの仕様
│   │   ├── llm-chat.md               LLM チャット連携
│   │   ├── terminal.md               ターミナルの機能仕様
│   │   └── task-search.md            タスク検索
│   └── mockups/                      画面・部品の見た目を検討する HTML と CSS
│       └── components/               部品ごとのモック
├── data/                             [データ] Beni 自身の既定保存先。実行時に作成
│   └── beni.sqlite                   プロジェクトの登録情報（関連ファイルも同じ場所）
├── node_modules/                     [生成] インストールした依存パッケージ
├── README.md                         概要、起動方法、保存先、機能、テスト方法
├── AGENTS.md                         このリポジトリで作業するエージェント向けの指示
├── package.json                      依存パッケージと起動・ビルド・テストのコマンド
├── bun.lock                          Bun が解決した依存パッケージのバージョン
├── tsconfig.json                     バックエンド・フロントエンド共通の型チェック設定
├── vite.config.ts                    SolidJS のフロントエンドのビルド設定
├── vitest.config.ts                  ブラウザー環境を模擬するフロントエンドのテスト設定
├── .gitignore                        生成物・ローカルデータなどの Git 除外設定
└── LICENSE                           Apache License 2.0 のライセンス本文
```

仕様書には未実装の構想も含まれます。画面モックもアプリ本体とは別に管理しているため、現在の動作は実装とテストで確認してください。

保存先の変更と以前のデータの扱いは [README のデータの保存先](../README.md#データの保存先) を参照してください。

ソースの配置と公開 URL は別です。JavaScript・CSS は引き続き `/ui/build/app.js` と `/ui/generated.css` から配信します。
