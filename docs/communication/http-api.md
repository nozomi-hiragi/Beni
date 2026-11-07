# HTTP API

HTTP による取得・操作と、チャットのパック同期の契約を定義します。

## 共通規則

- 接続先は `http://127.0.0.1:3210`。ポートは `BENI_PORT` で変更可能。Tailscale Serve の HTTPS 公開 URL は `BENI_PUBLIC_ORIGIN` に指定する（パスや末尾 `/` なし）。
- URL のホスト名が `127.0.0.1` の場合、または URL の host（ポートを含む）が指定した公開 origin の host と一致する場合に受け付ける。それ以外は 403。WebSocket にも同じホスト制限がある。通常の GET に共通の Origin 検査はない。
- POST は `Origin` がローカル要求 URL の origin、または公開 host に対しては設定した HTTPS origin と一致し、`Content-Type` が厳密に `application/json` であること。転送ヘッダーは判定に使わない。違反は 403。
- POST の本文は JSON オブジェクト。配列・null・不正 JSON は 400。本文上限は 65,536 バイトで、`/api/instructions/apply` に限り `65536 * 6 + 1024` バイト。超過は 413。
- JSON 応答には `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` を付ける。
- API のエラー本文は原則 `{ "error": "表示用メッセージ" }`。ホスト拒否の本文は JSON ではなく `Forbidden`。機械判定用の共通エラーコードは設けない。
- 下表のエラーのほか、ハンドラーの共通処理では GET の例外を JSON の 500、POST の解析・保存先処理などの例外を JSON の 400 で返す。

## API 一覧

`projectId` とタスクIDは [データの共通ID規則](../data/README.md#idの共通規則) に従う文字列。プロジェクト用とタスク用を区別し、整数IDは受け付けない。タスク会話では、同じプロジェクトに属する `taskId` と `phase` が必須。Generalでは GET の `taskId` と `phase` を省略する。POST では null または省略で指定する。

| メソッド・パス | 入力 | 成功 | 個別の主なエラー |
| --- | --- | --- | --- |
| `GET /api/state` | なし | 200 `{projects: Project[], tasks: Task[]}` | — |
| `POST /api/projects` | `{name: string, folder: string}`。名前は空白のみ不可、folder は絶対パス | 201 `Project` | 400 入力・保存先不正、409 同じIDの別の作業フォルダーが登録済みで現存する |
| `GET /api/project-files` | query: `projectId`, 任意の相対 `path`。省略時はプロジェクト直下 | 200 `ProjectFileList` | 400 パス不正、404 プロジェクト・フォルダーを開けない |
| `GET /api/project-file` | query: `projectId`, ファイルの相対 `path` | 200 `ProjectFilePreview` | 400 パス不正、404 プロジェクト・ファイルを開けない |
| `POST /api/tasks` | `{projectId: string, name: string}`。空白のみの名前は保存時に拒否 | 201 `Task` | 400 入力不正、404 プロジェクトなし |
| `POST /api/tasks/:id/delete` | `{projectId: string}` | 200 `{ok: true}`。タスク・文書・タスク会話を削除 | 404 タスクなし・所属不一致、409 チャット実行中、500 削除失敗 |
| `POST /api/tasks/:id/phase` | `{projectId: string, phase: string, target: string}`。現在と移動先の準備フェーズを指定 | 200 移動後の `Task` | 400 入力不正、404 タスクなし・所属不一致、409 実行中・フェーズ不一致 |
| `POST /api/tasks/:id/start` | `{projectId: string, phase: string, model: string \| null, provider?: "codex" \| "claude"}` | 200 実装中の `Task`。選択モデルへ実装開始の依頼を送信 | 400 入力不正・接続先やモデルを利用できない、404 対象なし、409 実行中・フェーズ不一致・実装手順未編集、500 開始失敗 |
| `POST /api/tasks/:id/stop` | `{projectId: string, phase: "execution"}` | 200 停止完了後の実装手順の `Task` | 400 入力不正、404 対象なし、409 フェーズ不一致・停止処理中、500 停止失敗 |
| `POST /api/tasks/:id/complete` | `{projectId: string, phase: "retrospective"}` | 200 `phase: finalization` の `Task` | 400 入力不正・接続先やモデルを利用できない、404 対象なし、409 フェーズ・状態不一致・自動精査未完了・処理中、500 開始失敗 |
| `POST /api/tasks/:id/reopen` | `{projectId: string, phase: "finalization" または "retrospective"}` | 200 反省会・`status: idle` の `Task` | 404 対象なし、409 フェーズ・状態不一致 |
| `POST /api/tasks/:id/rename` | `{projectId: string, name: string}`。名前の前後の空白を除く | 200 更新後の `Task` | 400 名前不正、404 タスクなし・所属不一致、500 保存失敗 |
| `GET /api/tasks/:id` | パスのタスク ID | 200 `TaskDetail` | 404 タスクなし、500 文書取得失敗 |
| `POST /api/tasks/:id/retry-review` | `{projectId: string}` | 202 `{ok: true}`。反省会の自動精査を再試行 | 404 タスクなし・所属不一致、409 `retrospective`・`idle`・精査 `failed` の条件を満たさない |
| `POST /api/tasks/:id/retry-instructions` | `{projectId: string}` | 202 `{ok: true}`。インストラクション更新を再試行 | 404 タスクなし・所属不一致、409 `completed`・更新ジョブ `failed` の条件を満たさない |
| `POST /api/folders/list` | `{path?: string}`。指定時は絶対パス | 200 `FolderList` | 400 パス不正・開けない |
| `GET /api/codex/status` | なし | 200 `CodexStatus` | 接続失敗時は一部の情報を unknown/null として返す |
| `GET /api/claude/status` | なし | 200 `ClaudeStatus` | 接続失敗時はunknown/nullとして返す |
| `POST /api/codex/status` | 空の JSON オブジェクト `{}` | 200 `CodexStatus`。接続状態と利用枠を再確認 | 400 入力不正 |
| `POST /api/claude/status` | 空の JSON オブジェクト `{}` | 200 `ClaudeStatus`。接続状態と利用枠を再確認 | 400 入力不正 |
| `GET /api/chat` | query: `projectId`, 任意の `taskId`、タスクでは `phase` | 200 `Conversation` | 400 フェーズ不正、404 会話対象なし、500 履歴取得失敗 |
| `POST /api/chat/send` | `{projectId, taskId?, phase?, content, model, provider?, instructionFocus?}`。content は空白のみ不可、model は256 UTF-16コード単位以内の文字列か null | 202 `Conversation` | 400 入力不正・接続先やモデルを利用できない・設定不適合、404 対象なし、409 送信中・フェーズや状態の不一致、500 保存・接続失敗 |
| `POST /api/chat/commands` | `{projectId, taskId?, phase?, command, args?, provider?, model?}` | 202 `{command: ChatCommand}` | 400 入力不正・未対応コマンド・接続先利用不可、404 対象なし、409 実行中・セッションなし・接続先やフェーズ・状態の不一致、500 保存・接続失敗 |
| `POST /api/chat/interrupt` | `{projectId, taskId?, phase?}` | 200 `{ok: true}` | 400 フェーズ不正、404 対象なし、409 停止対象なし・状態不一致、500 保存・接続失敗 |

タスクチャットの `phase` は `requirements`・`documents`・`implementation`・`execution`・`retrospective`・`finalization` のいずれかとする。

`chat/send` の 202 は受け付けであり、返答終了ではない。メッセージの送信は `/api/chat/send` を使う。

準備中は `requirements`・`documents`・`implementation` 間を選択できる。`phase` で別フェーズの `documents` または `implementation` へ移ると、そのフェーズの文書を作成・見直しする依頼を自動送信する。自動送信に失敗してもフェーズの変更は保存される。`start` は `execution` の会話へ実装開始の定型依頼を送る。`stop` が完了すると `implementation` へ戻る。

プロジェクト作成は `.beni/` を初期化し、タスク作成はタスクのメタデータと初期文書を保存する。`GET /api/state` とタスク詳細取得では実装中・終了フェーズの中断状態なども復旧する。`GET /api/chat` は実行中でない pending/streaming メッセージを unknown に更新する場合がある。

## データ形式

以下の型はワイヤー上の主な項目を示す。会話の応答には内部のセッション管理用項目も含まれる場合がある。

```ts
type Project = { id: string; name: string; folder: string };
type Task = { id: string; projectId: string; name: string; phase: string; status: string; createdAt: string | null; updatedAt: string | null };
type DocumentProvenance = { revision: string; items: { id: string; start: number; end: number }[] };
type Document = { name: string; path: string; content: string; version: number; provenance?: DocumentProvenance };
type TaskDetail = {
  task: Task; documents: Document[]; canStart: boolean;
  workflow: {
    review: { state: 'pending' | 'running' | 'done' | 'failed'; remaining: number; error: string | null } | null;
    instructionJob?: {
      id: string; projectId: string; taskId: string; revision: string;
      provider: 'codex' | 'claude'; model: string | null;
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
  provider: 'codex' | 'claude'; model: string | null; createdAt: string; updatedAt: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  threadId: string | null; sessionId: string | null; errorCode?: 'MODEL_UNAVAILABLE'; systemGenerated?: true;
};
type ChatCommand = {
  id: string; name: 'compact' | 'clear' | 'context' | 'usage';
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  error?: string; output?: string;
};
type Conversation = {
  version: 1; id: string; projectId: string; taskId: string | null; phase: string | null; lastEventId: number;
  threadId: string | null; sessionId: string | null; sessionProvider?: 'codex' | 'claude';
  selectedModel: {id: string; name: string; provider?: 'codex' | 'claude'} | null; messages: ChatMessage[];
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

`POST /api/chat/commands` は通常の発言とは別の操作で、`command` にスラッシュを除いた名前を指定する。`compact`・`clear` と、Claude用の `context`・`usage` を受け付ける。`new`・`reset` は `clear`、`cost`・`stats` は `usage` の別名。`args` は省略または空白だけの文字列を指定できる。`provider` は `codex` または `claude`、`model` はモデルIDまたはnull。インストラクション編集相談では `projectId: "instructions"`, `taskId: null` を使い、`instructionFocus` を省略する。

FEは選択中モデルの `provider` と `model` を送る。`compact`・`context`・`usage` は保存済みの `threadId` と `sessionProvider` に対して実行し、指定した `provider` が一致しなければ409で拒否する。これらの操作で接続先を切り替えたり、新規セッションを作ったりしない。`provider` 省略時は保存済みの接続先を使う。操作中に会話のメッセージとパック列を変更しない。未知の名前や入力不正は400、セッションなし・同じタスクの処理中・タスクの状態不一致は409とする。

`clear` はセッションのない会話でも実行できる。元の会話JSONを `history/<会話ID>.json` に保存してから、新しい会話ID・空のメッセージとパック列へ置き換える。CLIのセッションIDとフォーカス通知の状態も初期化する。保存失敗時は元の会話を維持し、成功後の `GET /api/chat` で新しいIDを取得する。FEは会話IDの変更に合わせてパックのキャッシュを切り替える。

通常の送信は、会話ごとに Codex と Claude のセッションを保存する。モデル変更や Beni の再起動後も同じ接続先のセッションを再開し、接続先を往復したときは別の接続先で進んだ会話の抜粋を追加する。再開先が消失したと CLI がターン受理前に明示した場合は、セッションを新規に作成し、保存済み会話の抜粋を添えて同じ送信を一度だけ開始する。認証・モデルの拒否や結果不明の切断では保存済みセッションを維持する。Codex の埋め込みツールは開始時に登録するため、保存済みスレッドのツール構成では現在必要なツールを使えない場合は新しいスレッドに切り替える。

生成を伴う対応コマンドは `/api/chat/send` を使い、選択モデルと元の入力を送る。BEはコマンド名と接続先を照合し、対応するAPIまたは固定の依頼へ変換する。未対応の名前、操作用コマンド、フロントエンド内のコマンドを通常のLLMメッセージへフォールバックしない。

202は要求の受付であり、処理完了を示さない。`Conversation.command` に最新の操作ID・名前・状態を保存する。`context`・`usage` の正常終了時は、最大65,536 UTF-8バイトの `output` を含める。状態が変わるたび既存の `chat.changed` を通知し、FEは `GET /api/chat` で再取得する。操作結果を新しい本文パックにはしない。コマンド専用のWSイベントも作らず、再接続時は同じ取得で同期する。

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
  provider?: 'codex' | 'claude'; model: string | null; createdAt: string; closedAt?: string;
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

Claudeのパックでは上記配列の末尾へ文字列 `"claude"` を追加する。providerの省略と `"codex"` は既存の配列を使い、過去のパックのハッシュを変えない。

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

送信・実装開始の `provider` は `codex` または `claude`。省略時は既存クライアント互換として `codex`。モデルIDは接続先の生IDを送り、画面表示の接頭辞は含めない。選択した接続先だけへ送信し、他方へ自動変更しない。

実装中・終了フェーズ・完了済みタスクと、反省会の自動精査が `pending` または `running` のタスクでは、`chat/send`・`chat/interrupt`・`chat/commands` を409で拒否する。実装中はタスクの `stop` を利用できる。停止以外で実装が終わると、BEが反省会への遷移を保存して自動精査を始める。精査完了後の `complete` は終了の定型依頼を送信する。ナレッジの版が確定すればタスクを完了し、確定できなければ反省会に戻す。終了のチャットは履歴を取得・購読できる。処理中の `reopen` は409で拒否し、完了後の `reopen` で反省会に戻す。

## インストラクション

`GET /api/instructions` は `{instructions: [{key, content}], editorState: {pending, busy}, provenance}` を返します。Markdownテンプレートを変数未展開で取得します。`pending` は保存された編集用プロンプトと会話に適用済みの本文の差、`busy` は編集相談の送信準備・生成中を示します。`provenance` は根拠を持つテンプレートだけを含む、指示キーから `DocumentProvenance` への対応です。

`POST /api/instructions/apply` は `{expected_content: string}` を受け取り、保存された編集用本文と一致し、会話が実行中でないときに新しい空の会話へ切り替えます。成功時は `{editorState: {pending: false, busy: false}}` を返します。同一originを必須とし、本文の競合や実行中は409です。変更なしなら会話をリセットしません。成功時は `chat.changed` で各クライアントに通知します。適用リクエストだけは64KiBの本文がJSONエスケープで膨らむ場合に対応し、リクエスト上限を `65536 * 6 + 1024` バイトとします。他のAPIは64KiBの上限を維持します。本文自体のHTTP更新APIはありません。詳細は [インストラクション管理](../features/instructions.md) を参照してください。

### インストラクション編集相談

既存のチャットAPIで `projectId: "instructions"`、`taskId: null`、phaseなしをアプリ共通の編集相談スコープとして扱います。これはプロジェクトIDではなく、プロジェクト登録やタスク、ターミナル、イベントAPIでは使えません。会話取得・送信・中断・パック一覧と取得・ハッシュ確認は既存の契約に従います。

WebSocketも `chat` トピックに限りこのスコープを許可します。指示保存後は `chat.changed` を受けて指示一覧を再取得します。

編集相談の送信では `instructionFocus`（`common`、各フェーズのキー、`editor` のいずれか）を必須とします。未選択・未知の対象は履歴追加前に拒否します。会話の `lastInstructionFocus` は最後に受理された送信の対象を表し、クリックによる選択とは別です。

フォーカス対象のキー・本文は初回、対象変更、保存本文変更、新しいLLMセッション開始時に渡します。全テンプレートを毎回送信せず、編集相談専用の `list_instructions`・`get_instruction` で必要な指示を取得します。これらはLLMの埋め込みツールであり、追加のHTTPエンドポイントではありません。
