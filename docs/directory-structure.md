# ディレクトリ構成

Beni は一つのアプリケーションとして管理し、サーバー側を `src/backend/`、ブラウザー側を `src/frontend/`、共通の通信定義を `src/shared/` に分けています。設定ファイルはルート、テストは対象コードの近くに置きます。

フロントエンドでは画面ごとのフォルダーを直下に並べます。画面専用の部品は各画面の `components/`、複数画面で使う部品や処理はフロントエンドの `shared/` に置きます。

`[生成]` と `[データ]` は Git 管理の対象外です。テストファイルは一部を `*.test.tsx` としてまとめています。

```text
Beni/
├── src/                              アプリケーションのコード
│   ├── backend/                      Bun で動くサーバー側の処理
│   │   ├── server.ts                 サーバー起動、API、フロントエンド配信、保存先設定
│   │   ├── server.test.ts            API・配信・文書管理・変更通知・保存先のテスト
│   │   ├── instructions.ts           指示テンプレートの初期値と変数の置換
│   │   ├── chat.ts                   会話の保存・再開・イベント配信・中断
│   │   ├── chat-history.ts           会話 JSON の変換と旧形式の読み取り
│   │   ├── claude.ts                 Claude の SDK 送信、CLI 操作、状態確認とストリーム変換
│   │   ├── claude.test.ts            Claude の受信・権限設定・中断・接続失敗のテスト
│   │   ├── chat.test.ts              会話の保存・再開・中断・分離、接続エラーのテスト
│   │   ├── agents/                   Agent の共通契約、標準の登録、接続先アダプター
│   │   │   ├── agent.ts              実行・セッション・イベント・利用枠の型
│   │   │   ├── index.ts              標準の Agent 一覧
│   │   │   ├── codex.ts              Codex App Server との接続
│   │   │   └── claude.ts             Claude の SDK・CLI 通信と共通型の変換
│   │   ├── data.ts                   メタデータ検証・保存と旧 Markdown が残ったタスクの復元
│   │   ├── documents.ts              旧 Markdown の検出・取り込み補助と変更監視
│   │   ├── document-table.ts         文書の項目・根拠と版の保存
│   │   ├── document-workflow.ts      文書用ツール、実装と反省会の進行、指示更新ジョブ
│   │   ├── retrospective-signals.ts  反省会で使う文書の引用状況と実装履歴の集計
│   │   ├── project-events.ts         プロジェクトイベント・文書差分・版の復元
│   │   ├── project-files.ts          作業フォルダーの一覧・テキスト読み取り
│   │   ├── rate-limits.ts            CLI が返す利用枠の正規化
│   │   ├── embedded-tools.ts         LLM向けイベント参照ツールの定義・入力検証
│   │   ├── manual-tools.ts           手動ツールの対象検証・直接実行・状態照合
│   │   ├── terminal.ts               PTY・端末画面・操作権・終了処理
│   │   ├── terminal.test.ts          シェルの存続・排他・画面復元・HTTP/WSのテスト
│   │   ├── events.ts                 共通 WS の接続・購読・送信上限と解放処理
│   │   ├── *.test.ts                 バックエンドの機能・API テスト
│   │   ├── store/                    メタデータとデータベースへのアクセス
│   │   │   ├── index.ts              プロジェクト・タスク・文書・指示・更新ジョブの管理
│   │   │   └── index.test.ts         メタデータ・復元のテスト
│   │   └── test/                     バックエンドのテスト補助
│   │       ├── dummy-agent.ts         Agent の共通処理を検証する実行先
│   │       ├── fake-codex.ts          実サービスを使わず Codex 通信を模擬する実行ファイル
│   │       └── fake-claude.ts         SDK の起動先と保守コマンドで使うテスト用 Claude CLI
│   ├── shared/                       FE・BE 共通の通信定義
│   │   ├── ids.ts                    プロジェクト・タスクIDの生成と種別検証
│   │   ├── task-phase.ts             共通のフェーズ識別子と検証
│   │   ├── agent.ts                  Agent ID・登録情報・接続状態の共通型
│   │   ├── chat-commands.ts          コマンドの一覧・接続先別の対応・入力解析
│   │   ├── manual-tools.ts           手動ツールの API 型と引数スキーマ検証
│   │   ├── communication.ts          パック・WS メッセージの型、受信検証、ハッシュ
│   │   └── project-files.ts          プロジェクトファイル一覧・プレビューの型
│   └── frontend/                     ブラウザーで動く SolidJS の画面
│       ├── index.html                アプリの表示先と JavaScript・CSS の読み込み
│       ├── main.tsx                  SolidJS アプリを HTML に取り付ける入口
│       ├── App.tsx                   URL に応じた画面の切り替えと共通ヘッダー
│       ├── App.test.tsx              画面遷移とルーティングのテスト
│       ├── assets.d.ts               CSS import の型宣言
│       ├── tailwind.css              Tailwind CSS の探索対象、daisyUI のテーマ、共通スタイル
│       ├── home/
│       │   ├── HomePage.tsx          プロジェクト・タスク作成、タスク一覧と並べ替え
│       │   └── components/
│       │       ├── TaskCreate.tsx    プロジェクトを選び、タスクを作成するフォーム
│       │       ├── TaskList.tsx      タスク一覧と並べ替え操作
│       │       ├── ProjectCreateDialog.tsx  プロジェクトの名前・フォルダーを指定するダイアログ
│       │       └── FolderPicker.tsx  バックエンドが動く環境のフォルダー選択
│       ├── project/
│       │   ├── ProjectPage.tsx       プロジェクトとタスクを確認し、作業画面を表示
│       │   └── components/
│       │       ├── Workspace.tsx     チャット・タスク・文書の表示とタブ管理
│       │       ├── TerminalPanel.tsx ターミナルタブ・描画・操作権・再接続
│       │       ├── PhaseIndicator.tsx フェーズ表示と実装開始・停止・タスク完了・再開
│       │       ├── ProjectFiles.tsx  作業フォルダーのツリーとファイルのプレビュー
│       │       ├── CodePreview.tsx   テキストの行番号と構文強調
│       │       └── TreeView.tsx      項目の階層表示と選択
│       ├── instructions/
│       │   └── InstructionsPage.tsx インストラクション管理画面
│       ├── tools/
│       │   ├── ManualTools.tsx       Navbar のツール一覧・実行・結果ダイアログ
│       │   └── ToolArguments.tsx     引数スキーマに応じた入力フォーム
│       ├── settings/
│       │   └── SettingsPage.tsx     登録済み Agent の接続状態と利用枠の確認
│       ├── shared/
│       │   ├── api.ts                バックエンドへの JSON リクエストとエラー処理
│       │   ├── model-cache.ts        CLI の接続状態・利用枠とモデル選択の記憶
│       │   ├── communication.ts      共通 WS、購読の共有、再接続
│       │   ├── chat-sync.ts          チャットのパック照合・順序付き確定・再同期
│       │   ├── chat-scroll.ts        最下部にいる間のスクロール追従
│       │   ├── phase-display.ts      フェーズの表示名と対応する文書
│       │   ├── types.ts              プロジェクト・タスク・文書・会話などの画面側の型
│       │   └── components/
│       │       ├── Navbar.tsx         共通ヘッダーと画面の移動
│       │       ├── UsageIndicators.tsx  接続先ごとの利用枠ゲージ
│       │       ├── ChatPanel.tsx      会話、モデル選択、送信・中断、履歴表示
│       │       ├── ChatComposer.tsx   テキスト入力と送信フォーム
│       │       ├── ContextGauge.tsx   コンテキスト使用率と圧縮メニュー
│       │       ├── ModelPicker.tsx    チャット用モデルの選択と接続先アイコン
│       │       ├── chat-popup.ts      チャット内のポップアップの表示可能な高さ
│       │       ├── ResizeHandle.tsx   作業領域の左右・上下比率を調整するハンドル
│       │       ├── TabBar.tsx          タブの選択と閉じる操作
│       │       ├── MarkdownPreview.tsx  Markdown の変換・サニタイズ・装飾表示
│       │       ├── PromptTableMarkdownPreview.tsx  出典と根拠を表示する Markdown プレビュー
│       │       ├── markdown-provenance.ts  根拠付き項目の範囲と取得 API
│       │       └── icons/             ナビゲーションや利用枠表示のアイコン
│       └── test/                     複数の実装をまたぐテストとテスト補助
│           ├── WorkspaceTrees.test.tsx  タスク・文書ツリーのテスト
│           ├── test-events.ts        WS とパックを模擬するテスト補助
│           ├── ChatCommands.test.tsx  スラッシュコマンドのテスト
│           ├── ClaudeChat.test.tsx     Claude チャットのテスト
│           ├── CodexChat.test.tsx      Codex チャットのテスト
│           └── RegisteredAgents.test.tsx 登録済み Agent のテスト
├── dist/                             [生成] ビルド出力
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
│   ├── specification.md             アプリ全体の確定仕様
│   ├── future-considerations.md     未決定の構想と検討事項
│   ├── traceable-documents-design.md 文書の根拠・版とフェーズ間の引き継ぎ
│   ├── project-events/               イベント・過去版の保存と埋め込みツール
│   ├── screens/                      画面ごとの仕様
│   │   ├── home.md                   ホーム画面
│   │   ├── project-detail.md         プロジェクト詳細画面
│   │   ├── project-settings.md       プロジェクトの登録と作業場所
│   │   └── settings.md               設定画面
│   ├── objects/                      オブジェクト仕様
│   │   ├── README.md                 目次と各要素の関係
│   │   ├── project.md                プロジェクトの持ち物と操作
│   │   ├── task.md                   タスクと文書
│   │   ├── chat.md                   会話・発言・返信パック
│   │   ├── task-events.md            フェーズ間の変更履歴と文書の版
│   │   └── terminal.md               ターミナルとシェル
│   ├── features/                     機能ごとの仕様
│   │   ├── instructions.md           インストラクション管理と編集相談
│   │   ├── llm-chat.md               LLM チャット連携
│   │   ├── terminal.md               ターミナルの機能仕様
│   │   └── task-search.md            タスク検索
│   └── mockups/                      過去の画面・部品の検討用 HTML と CSS
│       └── components/               部品ごとのモック
├── data/                             [データ] Beni 自身の既定保存先。実行時に作成
│   ├── beni.sqlite                   プロジェクトの登録情報・インストラクション・指示更新キュー
│   ├── rate-limits-<provider>.json   接続先ごとの利用枠キャッシュ
│   ├── chat/
│   │   ├── instructions.json         インストラクション編集相談の会話
│   │   ├── instruction-history/      編集用指示の適用前の会話（会話ID.json）
│   │   └── history/                  リセット前の編集相談の会話（会話ID.json）
│   └── instruction-editor/           編集相談CLIの作業先（書き込み不可）
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

ソースの配置と公開 URL は別です。静的ファイルの URL は [HTTP API の静的配信](communication/http-api.md#静的配信) を参照してください。
