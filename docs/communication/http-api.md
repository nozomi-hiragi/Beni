# HTTP API

HTTP による取得・操作と、チャットのパック同期の契約を定義します。

## 共通規則

- 接続先は `http://127.0.0.1:3210`。ポートは `BENI_PORT` で変更可能。Tailscale Serve の HTTPS 公開 URL は `BENI_PUBLIC_ORIGIN` に指定する（パスや末尾 `/` なし）。
- URL のホスト名が `127.0.0.1` でも、URL の host（ポートを含む）が指定した公開 origin と完全一致するものでもなければ 403。WebSocket も同じ制限。通常の GET に共通の Origin 検査はない。
- POST は `Origin` がローカル要求 URL の origin、または公開 host に対しては設定した HTTPS origin と一致し、`Content-Type` が厳密に `application/json` であること。転送ヘッダーは判定に使わない。違反は 403。
- POST の本文は JSON オブジェクト。配列・null・不正 JSON は 400。本文上限は 65,536 バイトで、超過は 413。
- HTMLのCSPはスクリプトを同一originに制限する。xterm.jsが生成するスタイル要素・属性のため、CSSのインライン適用は許可する。MarkdownプレビューのHTMLサニタイズは維持する。
- JSON 応答には `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` を付ける。
- API のエラー本文は原則 `{ "error": "表示用メッセージ" }`。ホスト拒否の本文は JSON ではなく `Forbidden`。機械判定用の共通エラーコードは設けない。
- 下表のエラーのほか、POST の解析・保存先処理などの例外は共通処理で 400 になる。GET のすべての例外が JSON エラーに統一されているわけではない。

## API 一覧

`projectId` とタスクIDは [データの共通ID規則](../data/README.md#idの共通規則) に従う文字列。プロジェクト用とタスク用を区別し、整数IDは受け付けない。チャットの `taskId` は同じプロジェクトのタスク ID または null。タスク会話では `phase` も必須で、Generalではnullまたは省略とする。GET の会話指定では `taskId` を省略すると一般会話、POST では null を明示する。

| メソッド・パス | 入力 | 成功 | 個別の主なエラー |
| --- | --- | --- | --- |
| `GET /api/state` | なし | 200 `{projects: Project[], tasks: Task[]}` | — |
| `POST /api/projects` | `{name: string, folder: string}`。名前は空白のみ不可、folder は絶対パス | 201 `Project` | 400 入力・保存先不正 |
| `POST /api/tasks` | `{projectId: string, name: string}`。空白のみの名前は保存時に拒否 | 201 `Task` | 400 入力不正、404 プロジェクトなし |
| `POST /api/tasks/:id/delete` | `{projectId: string}` | 200 `{ok: true}`。タスク・文書・タスク会話を削除 | 404 タスクなし・所属不一致、409 チャット実行中、500 削除失敗 |
| `POST /api/tasks/:id/phase` | `{projectId: string, phase: string, target: string}`。現在と移動先の準備フェーズを指定 | 200 移動後の `Task` | 400 入力不正、404 タスクなし・所属不一致、409 実行中・フェーズ不一致 |
| `POST /api/tasks/:id/start` | `{projectId: string, phase: string, model: string \| null, provider?: "codex" \| "claude"}` | 200 実装中の `Task`。選択モデルへ実装開始の依頼を送信 | 400 入力不正、404 対象なし、409 実行中・フェーズ不一致・実装手順未編集、500 開始失敗 |
| `POST /api/tasks/:id/stop` | `{projectId: string, phase: "execution"}` | 200 停止完了後の実装手順の `Task` | 404 対象なし、409 フェーズ不一致・停止処理中、500 停止失敗 |
| `POST /api/tasks/:id/complete` | `{projectId: string, phase: "retrospective"}` | 200 `status: completed` の `Task` | 404 対象なし、409 フェーズ・状態不一致、チャット実行中 |
| `POST /api/tasks/:id/reopen` | `{projectId: string, phase: "retrospective"}` | 200 反省会・`status: idle` の `Task` | 404 対象なし、409 フェーズ・状態不一致 |
| `POST /api/tasks/:id/rename` | `{projectId: string, name: string}`。名前の前後の空白を除く | 200 更新後の `Task` | 400 名前不正、404 タスクなし・所属不一致、500 保存失敗 |
| `GET /api/tasks/:id` | パスのタスク ID | 200 `{task: Task, documents: Document[], canStart: boolean}` | 404 タスクなし、500 文書取得失敗 |
| `POST /api/folders/list` | `{path?: string}`。指定時は絶対パス | 200 `FolderList` | 400 パス不正・開けない |
| `GET /api/codex/status` | なし | 200 `CodexStatus` | 接続失敗時は一部の情報を unknown/null として返す |
| `GET /api/claude/status` | なし | 200 `ClaudeStatus` | 接続失敗時はunknown/nullとして返す |
| `GET /api/chat` | query: `projectId`, 任意の `taskId`、タスクでは `phase` | 200 `Conversation` | 404 会話対象なし、500 履歴取得失敗 |
| `POST /api/chat/send` | `{projectId, taskId, phase, content, model, provider?}`。content は空白のみ不可、model は256文字以内の文字列か null | 202 `Conversation` | 409 送信中、400 Codex 利用不可・設定不適合、404 対象なし、500 保存・接続失敗 |
| `POST /api/chat/interrupt` | `{projectId, taskId, phase}` | 200 `{ok: true}` | 409 停止対象なし、404 対象なし、500 保存・接続失敗 |

タスクチャットの `phase` は `requirements`・`documents`・`implementation`・`execution`・`retrospective` のいずれかとする。

`chat/send` の 202 は受け付けであり、返答終了ではない。メッセージの送信は `/api/chat/send` を使う。

準備中は `requirements`・`documents`・`implementation` 間を選択できる。`execution` へ入るにはstartを使い、stop完了後は `implementation` へ戻る。phase操作ではエージェントを自動起動せず、startでは実装開始の定型依頼を実装中の会話へ送る。

プロジェクト・タスク作成は対応する文書ディレクトリも初期化する。タスク詳細取得でも必要な文書の初期化処理が走る。`GET /api/chat` は実行中でない pending/streaming メッセージを unknown に更新する場合がある。

## データ形式

以下はワイヤー上のデータを示す説明用の型。フロントエンドの型が一部の項目を省略していても、実際の応答には含まれる。

```ts
type Project = { id: string; name: string; folder: string };
type Task = { id: string; projectId: string; name: string; phase: string; status: string; createdAt: string | null; updatedAt: string | null };
type Document = { name: string; path: string; content: string; version: number };
type FolderList = {
  path: string; parent: string | null;
  directories: { name: string; path: string }[]; truncated: boolean;
};
type CodexStatus = {
  installed: boolean; path: string | null; version: string | null; checkedAt: string;
  auth: 'chatgpt' | 'apiKey' | 'other' | 'none' | 'unknown';
  models: { id: string; name: string }[] | null; usage: 'unknown';
};
type ClaudeStatus = Omit<CodexStatus, 'auth'> & {
  auth: 'claude' | 'apiKey' | 'other' | 'none' | 'unknown';
};
type ChatMessage = {
  id: string; sendId: string; role: 'user' | 'assistant'; content: string;
  provider: 'codex' | 'claude'; model: string | null; createdAt: string; updatedAt: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  threadId: string | null; sessionId: string | null; errorCode?: 'MODEL_UNAVAILABLE';
};
type Conversation = {
  version: 1; id: string; projectId: string; taskId: string | null; phase: string | null; lastEventId: number;
  threadId: string | null; sessionId: string | null; sessionProvider?: 'codex' | 'claude';
  selectedModel: {id: string; name: string; provider?: 'codex' | 'claude'} | null; messages: ChatMessage[];
};
```

- 一覧のプロジェクト・タスクは ID 降順。会話内のパックは保存された順序に従う。
- Document の path はファイル名。version はファイルの更新時刻 `mtimeMs` であり、DB 文書の版番号とは別。
- フォルダー一覧は直下の実ディレクトリのみ、最大 500 件。シンボリックリンクは一覧対象外。省略時はサーバー起動時の初期フォルダー（通常はホーム）。

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
  provider?: 'codex' | 'claude'; model: string | null; createdAt: string;
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

status/state は生成状態を表し、本文のハッシュには含めません。FE は終了通知の header から終了状態を受け取り、復元したパックを照合します。本文が一致すれば全文の再取得は不要です。

パック一覧は指定 ID より後を全件返します。ページングは行いません。HTTP の応答全体へ POST 本文の64 KiB制限は適用しません。

## 静的配信

`/`、`/settings`、`/project/:id`（プロジェクト用ID文字列）、`/ui/index.html` は同じ HTML を返す。`/ui/build/app.js` と `/ui/generated.css` は dist の生成物を返す。HTML と生成物には CSP、nosniff、no-store を設定する。画像は同一 origin と data URL を許可し、daisyUI の吹き出しが使う埋め込み SVG を表示する。スクリプト・スタイル・通信先は同一 origin に限定する。この配信は HTTP のまま。

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

実装中の一般の `chat/send`・`chat/interrupt` は409で拒否する。開始の定型送信とタスクのstopだけを使う。完了中も送信・中断・フェーズ変更・開始を409で拒否し、reopenで反省会を再開する。実装の終了はBEが反省会への遷移を保存して通知する。完了はLLMの応答終了と区別し、ユーザーのcomplete操作だけで確定する。
