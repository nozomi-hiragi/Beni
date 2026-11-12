# HTTP API

保存先と起動時の移行は [保存データの集約](../data/storage.md) を参照してください。

HTTP による取得・操作と、チャットのパック同期の契約を定義します。

## 共通規則

- 接続先は `http://127.0.0.1:3210`。ポートは `BENI_PORT` で変更可能。Tailscale Serve の HTTPS 公開 URL は `BENI_PUBLIC_ORIGIN` に指定する（パスや末尾 `/` なし）。
- URL のホスト名が `127.0.0.1` の場合、または URL の host（ポートを含む）が指定した公開 origin の host と一致する場合に受け付ける。それ以外は 403。WebSocket にも同じホスト制限がある。通常の GET に共通の Origin 検査はない。
- POST は `Origin` がローカル要求 URL の origin、または公開 host に対しては設定した HTTPS origin と一致し、`Content-Type` が厳密に `application/json` であること。転送ヘッダーは判定に使わない。違反は 403。
- POST の本文は JSON オブジェクト。配列・null・不正 JSON は 400。本文上限は 65,536 バイトで、`/api/instructions/apply` に限り `65536 * 6 + 1024` バイト。超過は 413。
- JSON 応答には `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` を付ける。
- API のエラー本文は原則 `{ "error": "表示用メッセージ" }`。ホスト拒否の本文は JSON ではなく `Forbidden`。機械判定用の共通エラーコードは設けない。
- 下表のエラーのほか、ハンドラーの共通処理では GET の例外を JSON の 500、POST の解析・保存先処理などの例外を JSON の 400 で返す。

作業フォルダーが見つからないプロジェクトは `folderAvailable: false`、保存領域の移行・取得に失敗したプロジェクトは `storageError` を返します。移行済みデータの取得は作業フォルダーに依存しません。フォルダー不在・変更処理中は、そのフォルダーを使用する送信・自動実行・ターミナル起動を開始できません。

## API 一覧

`projectId` とタスクIDは [データの共通ID規則](../data/README.md#idの共通規則) に従う文字列。プロジェクト用とタスク用を区別し、整数IDは受け付けない。タスク会話では、同じプロジェクトに属する `taskId` と `phase` が必須。Generalでは GET の `taskId` と `phase` を省略する。POST では null または省略で指定する。

| メソッド・パス | 入力 | 成功 | 個別の主なエラー |
| --- | --- | --- | --- |
| `GET /api/state` | なし | 200 `{projects: Project[], tasks: Task[]}` | — |
| `POST /api/projects` | `{name: string, folder: string}`。名前は空白のみ不可、folder は絶対パス | 201 `Project` | 400 入力・保存先不正、409 登録済みのID・パスと重複、旧データの移行失敗 |
| `POST /api/projects/:id/folder` | `{folder: string}`。サーバー上の絶対パス | 200 更新後の `Project` | 400 パス不正・存在しない、404 プロジェクトなし、409 実行中・登録済みパス・旧IDの衝突・移行失敗 |
| `GET /api/project-files` | query: `projectId`, 任意の相対 `path`。省略時はプロジェクト直下 | 200 `ProjectFileList` | 400 パス不正、404 プロジェクト・フォルダーを開けない |
| `GET /api/project-file` | query: `projectId`, ファイルの相対 `path` | 200 `ProjectFilePreview` | 400 パス不正、404 プロジェクト・ファイルを開けない |
| `POST /api/tasks` | `{projectId: string, name: string}`。空白のみの名前は保存時に拒否 | 201 `Task` | 400 入力不正、404 プロジェクトなし |
| `POST /api/tasks/:id/delete` | `{projectId: string}` | 200 `{ok: true}`。タスク・文書・タスク会話を削除。処理済みワークフローの会話は保持 | 404 タスクなし・所属不一致、409 チャット実行中または更新ジョブの待機中・実行中、500 削除失敗 |
| `POST /api/tasks/:id/phase` | `{projectId: string, phase: string, target: string}`。現在と移動先の準備フェーズを指定 | 200 移動後の `Task` | 400 入力不正、404 タスクなし・所属不一致、409 実行中・フェーズ不一致 |
| `POST /api/tasks/:id/start` | `{projectId: string, phase: string, model: string \| null, provider?: string}` | 200 実装中の `Task`。選択モデルへ実装開始の依頼を送信 | 400 入力不正・接続先やモデルを利用できない、404 対象なし、409 実行中・フェーズ不一致・実装手順未編集、500 開始失敗 |
| `POST /api/tasks/:id/stop` | `{projectId: string, phase: "execution"}` | 200 停止完了後の実装手順の `Task` | 400 入力不正、404 対象なし、409 フェーズ不一致・停止処理中、500 停止失敗 |
| `POST /api/tasks/:id/complete` | `{projectId: string, phase: "retrospective"}` | 200 `phase: finalization` の `Task` | 400 入力不正・接続先やモデルを利用できない、404 対象なし、409 フェーズ・状態不一致・自動分析未完了・処理中、500 開始失敗 |
| `POST /api/tasks/:id/reopen` | `{projectId: string, phase: "finalization" または "retrospective"}` | 200 反省会・`status: idle` の `Task` | 404 対象なし、409 フェーズ・状態不一致 |
| `POST /api/tasks/:id/rename` | `{projectId: string, name: string}`。名前の前後の空白を除く | 200 更新後の `Task` | 400 名前不正、404 タスクなし・所属不一致、500 保存失敗 |
| `GET /api/tasks/:id` | パスのタスク ID | 200 `TaskDetail` | 404 タスクなし、500 文書取得失敗 |
| `POST /api/tasks/:id/stop-review` | `{projectId: string}` | 200 `{ok: true}`。反省会の自動分析を停止 | 404 タスクなし・所属不一致、409 停止可能な分析なし、500 停止失敗 |
| `POST /api/tasks/:id/retry-review` | `{projectId: string}` | 202 `{ok: true}`。反省会の自動分析を再開・再試行 | 404 タスクなし・所属不一致、409 `retrospective`・`idle` で停止または失敗した分析がない、処理中 |
| `POST /api/tasks/:id/retry-instructions` | `{projectId: string}` | 202 `{ok: true}`。タスク完了ワークフローを再試行（URLは互換のため維持） | 404 タスクなし・所属不一致、409 `completed`・更新ジョブ `failed` の条件を満たさない |
| `POST /api/folders/list` | `{path?: string}`。指定時は絶対パス | 200 `FolderList` | 400 パス不正・開けない |
| `GET /api/agents` | なし | 200 `{agents: AgentInfo[]}`。起動時に登録した接続先の一覧 | |
| `GET /api/agents/:id/status` | なし | 200 `AgentConnectionStatus`。`agents` に保存した接続・認証・モデル候補と取得済みの利用枠。初回・無効化後だけ接続情報を確認 | 404 未登録 |
| `POST /api/agents/:id/status` | 空の JSON オブジェクト `{}` | 200 `AgentConnectionStatus`。接続情報を再確認し、対応する接続先の利用枠を再取得 | 400 入力不正、404 未登録 |
| `GET /api/codex/status` | なし | 200 `CodexStatus` | 接続失敗時は一部の情報を unknown/null として返す |
| `GET /api/claude/status` | なし | 200 `ClaudeStatus` | 接続失敗時はunknown/nullとして返す |
| `POST /api/codex/status` | 空の JSON オブジェクト `{}` | 200 `CodexStatus`。接続状態と利用枠を再確認 | 400 入力不正 |
| `POST /api/claude/status` | 空の JSON オブジェクト `{}` | 200 `ClaudeStatus`。接続状態と利用枠を再確認 | 400 入力不正 |
| `GET /api/chat` | query: `projectId`, 任意の `taskId`、タスクでは `phase` | 200 `Conversation` | 400 フェーズ不正、404 会話対象なし、500 履歴取得失敗 |
| `POST /api/chat/send` | `{projectId, taskId?, phase?, content, model, provider?, instructionFocus?}`。content は空白のみ不可、model は256 UTF-16コード単位以内の文字列か null | 202 `Conversation` | 400 入力不正・接続先やモデルを利用できない、404 対象なし、409 送信中・フェーズや状態の不一致、500 保存・接続失敗 |
| `POST /api/chat/commands` | `{projectId, taskId?, phase?, command, args?, provider?, model?}` | 202 `{command: ChatCommand}` | 400 入力不正・未対応コマンド・接続先利用不可、404 対象なし、409 実行中・セッションなし・接続先やフェーズ・状態の不一致、500 保存・接続失敗 |
| `POST /api/chat/context-usage` | `{projectId, taskId?, phase?, provider, model, refresh?}` | 200 `{contextUsage?: ContextUsage}` | 400 入力不正、404 対象なし、500 履歴の読み込み・保存失敗 |
| `POST /api/chat/interrupt` | `{projectId, taskId?, phase?}` | 200 `{ok: true}` | 400 フェーズ不正、404 対象なし、409 停止対象なし・状態不一致、500 保存・接続失敗 |

`GET /api/chat` は所属の指定に加え、任意の `chatId` で保存済み会話を取得できる。ワークフロー会話では `workflowJobId` も指定する。IDの形式と所属を照合し、参照がなければ404とする。`chatId` 省略時は現行会話を取得する。


タスクチャットの `phase` は `requirements`・`documents`・`implementation`・`execution`・`retrospective`・`finalization` のいずれかとする。

`chat/send` の 202 は受け付けであり、返答終了ではない。メッセージの送信は `/api/chat/send` を使う。

準備中は `requirements`・`documents`・`implementation` 間を選択できる。`phase` で別フェーズの `documents` または `implementation` へ移ると、そのフェーズの文書を作成・見直しする依頼を自動送信する。自動送信に失敗してもフェーズの変更は保存される。`start` は `execution` の会話へ実装開始の定型依頼を送る。`stop` が完了すると `implementation` へ戻る。

プロジェクト作成はアプリデータの `projects/<projectId>.sqlite` を初期化し、タスク作成はタスクのメタデータと初期文書を保存する。`GET /api/state` とタスク詳細取得では実装中・終了フェーズの中断状態なども復旧する。`GET /api/chat` は実行中でない pending/streaming メッセージを unknown に更新する場合がある。

## データ画面の読み取り

- `GET /api/data?view=files&scope=all&kind=all&query=&offset=0&limit=50` は `DataList` を返す。`view` は `files`（既定）・`chats`・`tasks`・`events`・`agents`・`db`。ファイル表示の所属は `all`、`app`、登録プロジェクトID、種類は `all`・`document`・`instruction`。DB表示は `database=all|app|登録プロジェクトID` と `table=all|テーブル名` で絞り込む。`limit` の既定値は50、上限は100。一覧には概要だけを含め、`total`・`offset`・`limit` と登録済みの `scopes`、DB候補 `databases`、実在テーブル候補 `tables`、取得日時 `observedAt` を返す。保存元ごとの読み取り失敗は `errors` に含め、読める他のデータは返す。
- `GET /api/data/detail?id=...&view=files` は `DataDetail` を返す。IDは一覧・関連項目・過去版から渡された不透明な識別子を使う。`fields`、`raw`、関連項目 `related`、過去版 `history` に加え、対象に応じて `document` または `conversation` を返す。ファイル・チャット詳細の `storageRows` は表示内容に使うDB行の配列で、各要素は保存元 `source`、テーブル名 `table`、全列の保存値 `row` を持つ。文書はheadと選択版、会話はchat_refsを含み、会話ファイル自体のJSONは `raw` に保持する。フィルター外のIDも参照できる。`view=db` の場合はDB行の保存値を返し、文書本文や履歴の解釈を行わないため、不正な文書JSONの列も確認できる。チャットJSONのIDはDB詳細の対象外。
- `view=files` の文書・インストラクションの一覧は保存元・文書スコープ・名前ごとに1件とし、件数とページ分割も文書単位で扱う。通常は最新版参照を選択IDに使い、旧版は詳細の `history` から参照する。最新版参照のない残存文書は最新の保存版を代表として返す。既存の版IDを使った詳細取得は維持する。
- チャット表示の `view=chats` は所属 `scope` と検索 `query` を受け取り、`chat_refs.scope_key` ごとの一覧を返す。`DataSummary.chatLocation` は場所の識別子、`chatVersionCount` は読み取れる会話版数。ファイル一覧には会話を含めない。チャット詳細は既存の会話IDを使い、`history` に同じ場所の全会話（`revision` はchatId、`updatedAt` は保存日時）を返す。過去版を選んでも `chatLocation` は同じ値になる。関連する会話への遷移は `view: chats` を指定する。
- ワークフロー会話の詳細は `conversation` に加えて `workflow` に実行管理情報を返す。`storageRows` に `instruction_jobs` と使用したタスク行を含める。ジョブへの関連先は対応チャットがあれば `chats`、なければ `db`。独立した `view=workflows` は設けない。
- `view=events` はプロジェクトDBの `events` を返す。`scope=all|プロジェクトID`、`eventType=all|保存された種類` と `query` で絞り込み、`eventTypes` に種類候補を返す。概要は `eventId`・`eventTask`・`eventPhase`、日時は `updatedAt` に持つ。`eventTask` はタスク名（取得不能ならID）、`eventPhase` は表示名。詳細の `event` は `type`・`at`・`taskId`・`taskName`・`phase`・`details` を持ち、`phase` は保存済みのキー、`taskName` は取得不能ならnull。JSONを解釈できない `details` は元の文字列を返す。`raw` は元のDB行を保持する。
- `view=tasks|agents` はそれぞれ `tasks`、`agents` を返す。所属 `scope`、状態 `status=all|保存値`、検索 `query` で絞り込み、`statuses` に所属内の状態候補を返す。全ビューで絞り込み後にページ分割する。概要の `subtitle` はフェーズ・対象タスクなどの表示補助。
- 各専用詳細は対応する表のIDだけを受け付け、`task`・`agent` を返す。形は共通型に定義する。元の行は `raw`、元の行を含む表示に使用した全行は `storageRows`、関連する保存データは `related` に持つ。JSONの不正値や復元不能は空データと区別する。文書詳細の `documentDiff` は選択版と直前版の本文差分を返す。`state` は `initial`・`unchanged`・`changed`・`unavailable`。差分がある場合は `patch`、前版が特定できる場合は `previousRevision`、比較不能の場合は `message` を持つ。初版、差分なし、比較不能を区別し、比較に使用した前版も `storageRows` に `role: previousVersion` として含める。CLIや作業ファイルを使わず、DBに書き込まない。
- `view=db` はBeni管理テーブルの行を集約せず返す。文書版・旧インストラクション行もすべて対象とし、チャットJSONファイルは含めない。行の概要には `database` と `table` を含める。候補 `tables` は空のテーブルも含む。
- `related[].view` は参照先に適したタブを表す。画面は参照先がファイル・チャット・イベント・DB行のどれかに応じてタブを切り替えられる。
- 型は `src/shared/data-browser.ts` に定義する。DBの行や複合キーと会話IDを区別するため、APIの `id` と保存データ内のIDは同一とは限らない。
- 不正な要求は400、詳細の対象がない場合は404、読み取りに失敗した詳細は500。エラーは表示用メッセージとし、内部例外や保存本文を含めない。
- 保存元はバックエンドで解決する。一覧・詳細APIはSQLを受け付けない。SQL専用APIも書き換えと任意パスを受け付けない。取得は保存内容を変更せず、初期化・移行・復旧・外部エージェントへの問い合わせを起動しない。
- SQLite行のJSON列は保存値を確認できるようにし、バイナリはサイズ・形式の情報で表示する。会話は保存JSONと表示用に解釈したデータを分ける。

### DBのSQL閲覧

- `GET /api/data/sql?database=app|登録プロジェクトID` は `DataSqlCatalog` を返す。省略時は `app`。登録DBの候補、選択DB、実在テーブル・ビューの名前、定義SQL、列の名前・型・NOT NULL・主キー、取得日時を返す。
- `POST /api/data/sql` は `{database: string, sql: string}` を受け取り `DataSqlResult` を返す。既存の同一オリジンと `application/json` の制限を適用する。SQL本文をURLやログへ残さない。
- 結果の `columns` は列名配列、`rows` は同じ列順の値配列の配列。同名列と0行時の列名も保持する。`truncated`、`elapsedMs`、`observedAt` を返す。
- 値はNULL・文字列・数値、大整数 `{type: 'integer', value: 十進文字列}`、BLOB `{type: 'blob', hex, bytes, truncated?}`。長い文字列は `{type: 'text', value, bytes, truncated: true}` とし、切り詰めた値を完全な保存値と混同しない。
- SELECT・WITHによるSELECT・EXPLAINの単一読み取り文に限る。読み取り専用接続で実行し、変更・接続先追加・設定変更・拡張読み込み・複数文・未束縛パラメーターを拒否する。SQLは64 KiB、結果は500行・1セル64 KiB・全体4 MiB、実行時間3秒まで。遅いSQLは専用のBun子プロセスを終了させて中断し、サーバー全体を停止させない。カタログ取得を含め同時実行は最大2件。SQL不正は400、時間切れは408、SQL・要求サイズ超過は413、同時実行上限は429、未登録DBは404、保存元を読めない場合は500。SQLite内部の単一値・レコードは16 MiB、ヒープは128 MiBを上限とする。
- 旧 `view=db` の一覧・詳細は関連レコードへの既存リンクのため維持する。SQLでの閲覧は固定テーブル定義に限定しない。保存形式の移行や実データの変更は行わない。

## データ形式

以下の型はワイヤー上の主な項目を示す。会話の応答には内部のセッション管理用項目も含まれる場合がある。

```ts
type Project = { id: string; name: string; folder: string; storageError?: string; folderAvailable?: false };
type Task = { id: string; projectId: string; name: string; phase: string; status: string; createdAt: string | null; updatedAt: string | null };
type DocumentProvenance = { revision: string; items: { id: string; start: number; end: number }[] };
type Document = { name: string; path: string; content: string; version: number; provenance?: DocumentProvenance };
type TaskDetail = {
  task: Task; documents: Document[]; canStart: boolean;
  workflow: {
    review: { state: 'pending' | 'running' | 'stopped' | 'done' | 'failed'; error: string | null } | null;
    instructionJob?: {
      id: string; projectId: string; taskId: string; revision: string;
      provider: string; model: string | null;
      status: 'pending' | 'succeeded' | 'failed' | 'superseded'; error?: string; reason?: string;
    };
  };
};
type FolderList = {
  path: string; parent: string | null;
  directories: { name: string; path: string }[]; truncated: boolean;
};
type ProjectFileList = { entries: { name: string; kind: 'directory' | 'file' }[]; truncated: boolean };
type ProjectFilePreview = { kind: 'text'; content: string } | { kind: 'binary' | 'too-large' };
type UsageWindow = {
  label: string; usedPercent?: number; resetsAt?: number;
  status?: 'allowed' | 'allowed_warning' | 'rejected';
};
type ProviderUsage = 'unknown' | { observedAt: string; windows: UsageWindow[] };
type AgentCommand = {
  name: string; description: string; kind: 'generation' | 'maintenance';
  requiresSession: boolean; aliases?: readonly string[]; argumentHint?: string;
};
type AgentInfo = {
  id: string; name: string; commands: readonly AgentCommand[]; supportsUsage: boolean;
  supportsContextUsage?: boolean;
};
type AgentConnectionStatus = {
  availability: 'ready' | 'not-installed' | 'unsupported-version' | 'unavailable';
  auth: 'subscription' | 'api-key' | 'other' | 'none' | 'unknown' | 'not-required';
  models: readonly {id: string; name: string}[] | null; checkedAt: string;
  version?: string; executablePath?: string; usage: ProviderUsage;
};
type CodexStatus = {
  installed: boolean; path: string | null; version: string | null; checkedAt: string;
  auth: 'chatgpt' | 'apiKey' | 'other' | 'none' | 'unknown';
  models: { id: string; name: string }[] | null; usage: ProviderUsage;
};
type ClaudeStatus = Omit<CodexStatus, 'auth'> & {
  auth: 'claude' | 'apiKey' | 'other' | 'none' | 'unknown';
};
type ChatMessage = {
  id: string; sendId: string; role: 'user' | 'assistant'; content: string;
  provider: string; model: string | null; createdAt: string; updatedAt: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  threadId: string | null; sessionId: string | null; errorCode?: 'MODEL_UNAVAILABLE'; systemGenerated?: true;
};
type ChatCommand = {
  id: string; name: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  error?: string; output?: string;
};
type ContextUsage = {usedTokens: number; maxTokens: number};
type Conversation = {
  version: 1; id: string; projectId: string; taskId: string | null; phase: string | null; lastEventId: number;
  threadId: string | null; sessionId: string | null; sessionProvider?: string;
  selectedModel: {id: string; name: string; provider?: string} | null; messages: ChatMessage[];
  contextUsage?: ContextUsage;
  sessions?: Partial<Record<string, {threadId: string | null; contextUsage?: ContextUsage}>>;
  command?: ChatCommand;
};
```

- 一覧のプロジェクト・タスクは ID 降順。会話内のパックは保存された順序に従う。
- `Document.path` は文書名。`version` はDB文書の更新順を比較できるミリ秒単位の値。根拠の取得には `provenance.revision` を使う。`canStart` は実装手順の文書が開始条件を満たすかを表し、接続先・モデル・タスク状態の検査は開始要求でも行う。
- フォルダー一覧は直下の実ディレクトリのみ、最大 500 件。シンボリックリンクは一覧対象外。省略時はサーバー起動時の初期フォルダー（通常はホーム）。
- `usage.observedAt` は取得日時、`usedPercent` は使用率（0〜100）、`resetsAt` はUnix時刻の秒。GET は同じアカウントについて保持している利用枠を返す。POST で取得できなかった場合も、同じアカウントの前回値を返すことがある。取得方法は [設定画面](../screens/settings.md) を参照。

### プロジェクトファイルの取得

一覧は指定フォルダーの直下から最大500件を返す。ディレクトリを先に並べ、それぞれ名前順に整列する。相対パスは4,096 UTF-16コード単位以内で、区切りは `/`。`projectId` と `path` の重複指定は400を返す。

プロジェクト内部データや依存パッケージ（`.beni`、`.git`、`node_modules` など）、代表的な認証情報ファイル（`.env`、秘密鍵など）、シンボリックリンクは一覧・本文取得の対象外。本文取得はリンク数が1の通常ファイルに限る。1 MiB超過は `too-large`、UTF-8としてデコードできないデータや所定の制御文字を含むデータは `binary` を返す。

## 文書の根拠

`GET /api/document-provenance` は、`name`、`revision`、`itemId` のクエリーを受け取り、200 `{reason, sources}` を返す。タスク画面の文書は `projectId` と `taskId` も指定する。インストラクションは `name` に指示キーを指定し、両IDを省略する。`revision` と `itemId` は文書取得時の `provenance` に含まれる。`items[].start` と `end` は連結済みMarkdownに対するゼロ起点のUTF-16コード単位で、終端は範囲に含まない。

`sources` には参照元の種別・ID・テキストが含まれ、参照先に応じて版、抜粋開始位置、プロジェクト名、タスク名も含まれる。形式不正や重複クエリーは400、該当する根拠がない場合は404。項目と参照元の詳細は [要求・根拠を追跡できる文書管理](../traceable-documents-design.md) を参照。

## チャットのコマンド

エージェント依存の候補は `GET /api/agents` が返す選択先の `commands` を使う。名前・説明・別名・引数のヒント・種別を各 Agent の宣言から受け取り、フロントエンドでは接続先 ID による固定一覧を補わない。未選択・未登録では候補なしとし、登録情報が旧 API のため取得できない場合は Beni の共通操作だけを使う。`clear`（別名 `new`・`reset`）は Beni 側の定義を加える。保守コマンドの `compact` は圧縮対応の判定に使い、入力補完と「コマンド」メニューからは除く。

`POST /api/chat/commands` は、登録済み Agent の保守コマンドと Beni の `clear` を受け付ける。`command` はスラッシュを除いた名前または別名。`args` はコマンドが対応する場合に指定できる。`provider` は登録 ID、`model` はモデルIDまたはnull。インストラクション編集相談では `projectId: "instructions"` と `taskId: null` を指定し、`instructionFocus` は省略する。

既存セッションが必要な保守コマンドは、指定した接続先とモデルの保存済みセッションに対して実行する。対象のセッションがない場合は409で拒否する。指定を省略した場合は会話の選択モデルを優先する。操作中も会話のメッセージとパック列は保持する。

コンテキストゲージの「圧縮」は `command: "compact"` を送る。会話取得・送信レスポンスでは、選択モデルの計測値を `contextUsage` に、他のモデルの計測値を `sessions["接続先ID/モデルID"].contextUsage` に含める。未計測の項目は省略する。

`POST /api/chat/context-usage` は、指定した接続先とモデルの保存済みセッションのコンテキスト使用量を取得する。通常は保存値があれば返し、未計測なら接続先からの取得を試す。ゲージの「更新」は `refresh: true` を指定し、保存値があっても再取得する。再取得できなければ応答の `contextUsage` を省略し、保存値があれば保持する。計測値を保存したときは `chat.changed` で通知する。

通常の送信は、会話とモデルごとにセッションを保存する。モデルを切り替えたときは、そのモデルがまだ受け取っていない会話の抜粋を追加する。再開先の消失やツール構成との不一致が受理前に確定した場合は、新規セッションで同じ送信を一度だけ実行する。認証・モデルの拒否や結果不明の切断では、保存済みセッションを維持する。

生成を伴う対応コマンドは `/api/chat/send` を使い、選択モデルと元の入力を送る。BEはコマンド名と接続先を照合し、対応するAPIまたは固定の依頼へ変換する。未対応の名前や操作用コマンドは拒否する。

202は要求の受付であり、処理完了を示さない。`Conversation.command` に最新の操作ID・名前・状態を保存する。保守コマンドが正常終了時に本文を返した場合は、最大65,536 UTF-8バイトの `output` を含める。状態が変わるたび既存の `chat.changed` を通知し、FEは `GET /api/chat` で再取得する。操作結果を新しい本文パックにはしない。コマンド専用のWSイベントも作らず、再接続時は同じ取得で同期する。

中断は `POST /api/chat/interrupt` を使う。終了を確認できないまま接続が切れた場合や再起動した場合は `unknown` とする。FEは受付・結果不明を自動再送しない。

## パック同期 API

共通の会話指定は `{projectId: string, taskId: string | null, phase?: string | null}`。パック ID は不透明な文字列であり、文字列の大小で並べない。BE が会話内の順序を管理する。

| メソッド・パス | 入力 | 成功応答 |
| --- | --- | --- |
| `GET /api/chat/packs` | query: projectId、任意の taskId、タスクではphase、任意の afterPackId | 200 `{packs: [{packId, state}]}`。指定 ID より後を順序どおり返す。省略時は先頭から |
| `GET /api/chat/packs/:packId` | query: projectId、任意の taskId、タスクではphase | 200 `{pack: Pack}`。終了済みパック全文 |
| `POST /api/chat/packs/:packId/ack` | 会話指定と `{hash: string}` | 200 `{matched: true}` または `{matched: false, pack: Pack}` |

`state` は `streaming` または `closed`。closed は生成処理がそのパックを閉じた状態で、FE の受け取り確定や生成の正常終了とは別。

- ack は FE が未確定内容を受け取り終えたときの照合。BE の生成や保存を進めるための承認ではない。同じ ack を再度送っても生成・保存内容を変更しない。
- ハッシュ不一致は通信上の同期結果なので 200 で正しい全文を返す。
- 未知のパック・会話に属さないパック・未知の afterPackId は 404 とし、勝手に空の一覧として扱わない。
- 生成中パックへの全文取得・照合は 409。入力不正は 400、保存済み内容の読み込み失敗は 500。
- 一覧は生成中パックも含む。FE は終了済みだけを全文取得し、生成中は WS の受信を続ける。

## パックの形式とハッシュ

```ts
type Pack = {
  packId: string; sequence: number; messageId: string; sendId: string;
  role: 'user' | 'assistant'; kind: 'text' | 'tool'; content: string;
  tool: {name: string; input: string; output: string} | null;
  provider?: string; model: string | null; createdAt: string; closedAt?: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  state: 'streaming' | 'closed';
};
type PackHeader = Omit<Pack, 'content' | 'tool'>;
```

sequence は会話内の生成順です。ユーザー発言も一つの終了済みパックとして記録します。一回の返信には複数の本文・ツールのパックが属し、sendId で送信と対応します。Conversation の messages は会話単位の履歴と実行状態を表します。パックは専用 API で取得し、バブル単位の表示・同期を担います。

本文パックの tool は null です。ツールパックの input/output は文字列で、構造化された値は JSON として表します。ツールの実行中の出力を本文差分へ混ぜず、終了したツールパックを HTTP で取得します。

ハッシュは次の配列を `JSON.stringify` し、UTF-8 バイト列へ変換した SHA-256 の小文字16進数64桁です。改行や空白を正規化しません。tool は `[name, input, output]` の配列へ変換するため、オブジェクトのキー順には依存しません。

```ts
[1, pack.packId, pack.sequence, pack.messageId, pack.sendId,
 pack.role, pack.kind, pack.content,
 pack.tool ? [pack.tool.name, pack.tool.input, pack.tool.output] : null,
 pack.model, pack.createdAt]
```

`provider` があり、値が `"codex"` 以外なら、上記配列の末尾へその ID を追加する。省略時と `"codex"` は従来の配列を使う。

status/state は生成状態を表します。正常終了したアシスタントのパックは、終了時刻の `closedAt` を持つ場合があります。吹き出しの所要時間は、そのパックの `createdAt` との差です。旧データでは終了時刻がないため、従来どおり「完了」と表示します。生成状態と終了時刻は本文のハッシュには含めません。FE は終了通知の header からこれらを受け取り、復元したパックを照合します。本文が一致すれば全文の再取得は不要です。

パック一覧は指定 ID より後を全件返します。ページングは行いません。HTTP の応答全体へ POST 本文の64 KiB制限は適用しません。

## 静的配信

`/`、`/settings`、`/instructions`、`/project/:id`（プロジェクト用ID文字列）、`/ui/index.html` は同じ HTML を返す。`/ui/build/app.js`、`/ui/generated.css`、`/ui/style.css`（xterm.js の CSS）は dist の生成物を返す。HTML と生成物には CSP、nosniff、no-store を設定する。スクリプト・外部スタイルシート・通信先は同一 origin に限定し、xterm.js が生成するインラインのスタイル要素・属性を許可する。画像は同一 origin と data URL を許可する。Markdown プレビューでは別途 HTML をサニタイズする。

## ターミナル管理

セッション情報とWSによる画面同期は [ターミナル通信](terminal.md) を参照してください。いずれも登録済みプロジェクトを対象とし、シェルの実行場所をブラウザーから直接指定しません。

| メソッド・パス | 入力 | 成功 | 個別の主なエラー |
| --- | --- | --- | --- |
| `GET /api/terminals` | query: `projectId` | 200 `TerminalSession[]` | 404 プロジェクトなし |
| `POST /api/terminals` | `{projectId, requestId}` | 201 `TerminalSession` | 400 入力不正、404 プロジェクトなし、409 上限・削除済み要求、503 サーバー終了中 |
| `POST /api/terminals/:id/close` | `{projectId, controlToken}` | 200 `{ok: true}` | 400 入力不正、403 操作権なし、404 対象なし、500 終了処理失敗 |

作成時の端末サイズは80列・24行です。購読成立と画面復元後、操作権を持つ画面がリサイズします。起動に失敗したセッションは `failed` として一覧に残し、画面で失敗を表示します。

`requestId` は1〜128文字の文字列で、同じプロジェクトと要求IDの組み合わせでは新しいシェルを重複作成しません。作成の応答を受け取れなかった場合は一覧で照合し、明示的な再試行にも同じIDを使います。セッションを削除した後に同じ要求IDを再利用しても、新しいシェルは起動しません。要求IDの保持はサーバーが起動している間です。

終了時の `controlToken` は個別シェルの `terminal.state` が現在の所有者へ返した値です。バックエンドは現在の所有者のトークンを照合し、権限を失効させてから終了処理を待ちます。終了済みセッションを一覧から削除する場合も操作権が必要です。

## タスク変更履歴

イベント一覧・文書の版の取得は [変更履歴の取得契約](../objects/task-events.md#取得と通知の契約) に従う。タスクへの送信は現在phaseとの一致を検証し、古い画面から別フェーズへ送信した場合は409。送信準備・実行中はタスク全体で排他とし、別フェーズからの送信や前後へのフェーズ変更を409で拒否する。取得・パック照合は指定したフェーズの会話に限定する。

`Conversation.selectedModel` は `{id, name, provider?}` または `null`。送信を受け付けたモデルを会話ごとに永続化する。モデル選択だけの保存APIは設けない。送信時にもモデルの利用状態を確認し、指定したモデルが利用できなければ代替モデルでは実行しない。

モデル利用不可の送信・開始要求には400と `{code: "MODEL_UNAVAILABLE", error: string}` を返す。この場合は会話に新しい送信を追加しない。受け付け後に接続先から明示的なモデル拒否が届いた場合は、該当するアシスタントメッセージに `errorCode: "MODEL_UNAVAILABLE"` を記録し、`chat.changed` による履歴再取得で通知する。FEは送信IDで元の入力を復元し、選択モデルを警告状態にする。受け付け済みの履歴・パックは失敗として残し、削除や自動再送はしない。一般的な拒否や通信断にはこのコードを付けない。

送信・実装開始の `provider` は登録 ID。省略時は登録順の先頭を使う。標準の構成では `codex`。モデルIDは接続先の生IDを送り、画面表示の接頭辞は含めない。選択した接続先だけへ送信し、他方へ自動変更しない。

実装中・終了フェーズ・完了済みタスクと、反省会の自動分析が `pending` または `running` のタスクでは、`chat/send`・`chat/interrupt`・`chat/commands` を409で拒否する。実装中はタスクの `stop`、自動分析中は `stop-review` を利用できる。停止以外で実装が終わると、BEが反省会への遷移を保存して自動分析を始める。自動分析を停止した場合は、反省会で `retry-review` を使って再開できる。分析完了後の `complete` は終了の定型依頼を送信する。ナレッジの版が確定すればタスクを完了し、確定できなければ反省会に戻す。終了のチャットは履歴を取得・購読できる。処理中の `reopen` は409で拒否し、完了後の `reopen` で反省会に戻す。

## インストラクション

`GET /api/instructions` は `{instructions: [{key, content}], editorState: {pending, busy}, provenance}` を返します。Markdownテンプレートを変数未展開で取得します。`pending` は保存された編集用プロンプトと会話に適用済みの本文の差、`busy` は編集相談の送信準備・生成中を示します。`provenance` は根拠を持つテンプレートだけを含む、指示キーから `DocumentProvenance` への対応です。

`POST /api/instructions/apply` は `{expected_content: string}` を受け取り、保存された編集用本文と一致し、会話が実行中でないときに新しい空の会話へ切り替えます。成功時は `{editorState: {pending: false, busy: false}}` を返します。同一originを必須とし、本文の競合や実行中は409です。変更なしなら会話をリセットしません。成功時は `chat.changed` で各クライアントに通知します。適用リクエストだけは64KiBの本文がJSONエスケープで膨らむ場合に対応し、リクエスト上限を `65536 * 6 + 1024` バイトとします。手動ツール API の上限は後述し、それ以外の API は64KiBの上限を維持します。本文自体のHTTP更新APIはありません。詳細は [インストラクション管理](../features/instructions.md) を参照してください。

### インストラクション編集相談

既存のチャットAPIで `projectId: "instructions"`、`taskId: null`、phaseなしをアプリ共通の編集相談スコープとして扱います。これはプロジェクトIDではなく、プロジェクト登録やタスク、ターミナル、イベントAPIでは使えません。会話取得・送信・中断・パック一覧と取得・ハッシュ確認は既存の契約に従います。

WebSocketも `chat` トピックに限りこのスコープを許可します。指示保存後は `chat.changed` を受けて指示一覧を再取得します。

編集相談の送信では `instructionFocus`（`common`、各フェーズのキー、`editor` のいずれか）を必須とします。未選択・未知の対象は履歴追加前に拒否します。会話の `lastInstructionFocus` は最後に受理された送信の対象を表し、クリックによる選択とは別です。

フォーカス対象のキー・本文は初回、対象変更、保存本文変更、新しいLLMセッション開始時に渡します。全テンプレートを毎回送信せず、編集相談専用の `list_instructions`・`get_instruction` で必要な指示を取得します。これらはLLMの埋め込みツールであり、追加のHTTPエンドポイントではありません。

## 手動ツール

Navbar の [ツール](../features/manual-tools.md) はモデルや CLI を呼ばず、Beni の埋め込みツールを直接実行する。会話やパックには操作内容を追加しない。

対象 `scope` は、プロジェクトなら `{kind: "project", projectId, taskId?}`、インストラクションなら `{kind: "instructions"}` とする。タスクを指定する場合は所属プロジェクトを検証し、フェーズはサーバーが現在の状態から解決する。GET では同じ項目をクエリに指定する。

| API | 入力・返却 |
| --- | --- |
| `GET /api/tools` | 対象を指定し、`{scope, label, phase, revision, tools, disabledReason?}` を取得する |
| `POST /api/tools` | `{scope, revision, operationId, name, input}` を送り、`{operation}` を取得する |
| `GET /api/tools/operations/:operationId` | 同じ対象をクエリに指定し、保存された `{operation}` を取得する |

`tools` の各項目は `name`、`description`、`category`（`events`・`documents`・`instructions`）、`effect`（`read`・`write`・`complete`）、`inputSchema` を持つ。`revision` は一覧取得時の定義と実行条件を表し、実行受付時に再検証する。`disabledReason` がある場合は実行できない。

`operation` は `id`、`scope`、`label`、`phase`、`name`、`input`、`status`、`createdAt`、`updatedAt` と、必要に応じて `output`・`error` を返す。状態は `running`・`completed`・`failed`・`interrupted`・`unknown`。新規操作の `phase` は受付時の実フェーズ（プロジェクト単体・指示は `null`）を保存する。結果は専用ダイアログで表示し、チャット同期には載せない。

新規受付は202、同じ操作の再受付は200。不正な引数は400、対象・操作の不存在や別スコープの参照は404、実行条件の変更や競合は409、本文超過は413を返す。

POST は既存 API と同じ origin 検証を適用する。本文上限は `65536 * 6 * 2 + 4096`（790528 バイト）とし、インストラクションの新旧本文がそれぞれ JSON エスケープで膨らむ場合も扱う。操作 ID の再利用は同じ対象・ツール・引数の場合だけ既存結果を返す。異なる入力での再利用、古い定義、実行中の競合は拒否する。通信切断時には GET で照合し、別 ID で自動再送しない。スコープ外の操作結果は返さない。
