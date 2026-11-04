# 通信の移行計画

通常の HTTP API を維持し、SSE を共通 WebSocket へ置き換え、チャットをパック単位のストリーム・同期へ移すためのたたき台です。まだ実装には着手していません。

振る舞いは [通信仕様](README.md) を参照します。この文書では現状、作業順序、確認項目を扱います。

## 対象

文書の更新通知とチャットのリアルタイム通信を移行します。一覧取得、作成、設定変更、チャット送信・中断などの通常の操作は HTTP に残します。静的配信と外部サービスとの通信は対象外です。

チャットにはパックの識別・順序・終了状態と、照合・補完用の HTTP API、FE の確定データ管理を追加します。既存の会話履歴を失わないよう、現在の保存形式との対応を実装前に確認します。

ターミナルはこの移行後の別の実装とし、完了条件には含めません。

## 移行元の実装

この節だけが移行前の実装記録です。`src/backend/server.ts`、`chat.ts`、`store/index.ts`、`documents.ts` で確認しました。ほかの通信文書はマージ後の仕様として保守します。

### 現行の共通規則

- 接続先は `http://127.0.0.1:3210`。ポートは `BENI_PORT` で変更可能。
- URL のホスト名が `127.0.0.1` 以外なら 403。通常の GET に共通の Origin 検査はない。
- POST は `Origin` が要求 URL の origin と一致し、`Content-Type` が厳密に `application/json` であること。違反は 403。
- POST の本文は JSON オブジェクト。配列・null・不正 JSON は 400。本文上限は 65,536 バイトで、超過は 413。
- JSON 応答には `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` を付ける。
- API のエラー本文は原則 `{ "error": "表示用メッセージ" }`。ホスト拒否の本文は JSON ではなく `Forbidden`。現行には機械判定用の共通エラーコードはない。
- 下表のエラーのほか、POST の解析・保存先処理などの例外は共通処理で 400 になる。GET のすべての例外が JSON エラーに統一されているわけではない。

### 現行 API 一覧

`projectId` は正の安全な整数。チャットの `taskId` は同じプロジェクトのタスク ID または null。GET の会話指定では `taskId` を省略すると一般会話、POST では null を明示する。

| メソッド・パス | 入力 | 成功 | 個別の主なエラー |
| --- | --- | --- | --- |
| `GET /api/state` | なし | 200 `{projects: Project[], tasks: Task[]}` | — |
| `POST /api/projects` | `{name: string, folder: string}`。名前は空白のみ不可、folder は絶対パス | 201 `Project` | 400 入力・保存先不正 |
| `POST /api/tasks` | `{projectId: number, name: string}`。空白のみの名前は保存時に拒否 | 201 `Task` | 400 入力不正、404 プロジェクトなし |
| `GET /api/tasks/:id` | パスのタスク ID | 200 `{task: Task, messages: StoredMessage[], documents: Document[]}` | 404 タスクなし、500 文書取得失敗 |
| `POST /api/tasks/:id/messages` | `{content: string}`。空白のみは保存時に拒否 | 201 `StoredMessage` | 400 入力不正、404 タスクなし |
| `POST /api/folders/list` | `{path?: string}`。指定時は絶対パス | 200 `FolderList` | 400 パス不正・開けない |
| `GET /api/codex/status` | なし | 200 `CodexStatus` | 接続失敗時は一部の情報を unknown/null として返す |
| `GET /api/chat` | query: `projectId`, 任意の `taskId` | 200 `Conversation` | 404 会話対象なし、500 履歴取得失敗 |
| `POST /api/chat/send` | `{projectId, taskId, content, model}`。content は空白のみ不可、model は文字列か null | 202 `Conversation` | 409 送信中、400 Codex 利用不可・設定不適合、404 対象なし、500 保存・接続失敗 |
| `POST /api/chat/interrupt` | `{projectId, taskId}` | 200 `{ok: true}` | 409 停止対象なし、404 対象なし、500 保存・接続失敗 |

`chat/send` の 202 は受け付けであり、返答終了ではない。`tasks/:id/messages` は DB へ保存するだけで Codex に送信しない。現在の FE からの呼び出しは見当たらず、パック同期 API と混同しない。

プロジェクト・タスク作成は対応する文書ディレクトリも初期化する。タスク詳細取得でも必要な文書の初期化処理が走る。`GET /api/chat` は実行中でない pending/streaming メッセージを unknown に更新する場合がある。

### 現行のデータ形式

以下はワイヤー上のデータを示す説明用の型。フロントエンドの型が一部の項目を省略していても、実際の応答には含まれる。

```ts
type Project = { id: number; name: string; folder: string };
type Task = { id: number; projectId: number; name: string; phase: string; status: string };
type StoredMessage = {
  id: number; project_id: number; task_id: number | null;
  role: string; content: string; created_at: string;
};
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
type ChatMessage = {
  id: string; sendId: string; role: 'user' | 'assistant'; content: string;
  provider: 'codex'; model: string | null; createdAt: string; updatedAt: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  threadId: string | null; sessionId: string | null;
};
type Conversation = {
  version: 1; id: string; projectId: number; taskId: number | null;
  threadId: string | null; sessionId: string | null; messages: ChatMessage[];
};
```

- 一覧のプロジェクト・タスクは ID 降順、DB メッセージは ID 昇順。
- Document の path はファイル名。version はファイルの更新時刻 `mtimeMs` であり、DB 文書の版番号とは別。
- フォルダー一覧は直下の実ディレクトリのみ、最大 500 件。シンボリックリンクは一覧対象外。省略時はサーバー起動時の初期フォルダー（通常はホーム）。
- 一回の送信で user/assistant メッセージを一組作り、assistant の content に差分を追記するのが現行実装。パック単位にはまだ分かれていない。

### 現行 SSE（移行後に撤去）

| GET パス | 入力 | 対象 |
| --- | --- | --- |
| `/api/chat/events` | query: projectId、任意の taskId | 会話 |
| `/api/tasks/:id/documents/events` | query: projectId、パスのタスク ID | タスク文書 |

Origin が指定されていて同一 origin でない場合、または `Sec-Fetch-Site: cross-site` なら 403。対象不正は 404、文書監視の準備失敗は 500。

応答は `text/event-stream`。接続直後に `retry: 1000` と `event: change` / `data: {}` を送り、その後の変更を 80 ms 単位でまとめる。5 秒ごとに keepalive コメントを送る。切断時に監視とタイマーを解放する。内容の差分やイベント履歴は送らない。FE は change を受けて会話・文書を HTTP で再取得し、定期ポーリングは行わない。対象切り替え時には購読を閉じ、再接続直後の change でも最新状態を取得する。


## 移行順序

1. 通信仕様の未確定事項を詰める。既存のチャットイベント・保存形式とパックの対応、ハッシュ規則、同期 API を決める。
2. 共通の型・受信検証・WS 接続管理・購読を実装する。
3. 文書の SSE を WS の変更通知へ移し、内容の取得は HTTP を維持する。
4. BE にパック ID・順序・終了状態・確定内容の保存を実装し、差分と終了を WS で送る。
5. パックのハッシュ照合、確定済み ID より後の ID 列取得、パック全文取得を HTTP で実装する。
6. FE に未確定のストリーム表示、順序どおりの確定・保持、再接続時の同期を実装する。
7. 不要になった SSE の入口・実装・テスト補助を撤去し、文書を実装に合わせる。

機能単位で切り替え、移行中に同じイベントを SSE と WS の両方から処理しないようにします。通常の HTTP API は撤去しません。未使用に見えるメッセージ保存 API は用途を確認し、今回の同期に関係しなければ別の整理として扱います。

## 検証

- 既存の HTTP によるプロジェクト・タスク操作、フォルダー選択、Codex 状態表示、チャット履歴取得・送信・中断が維持されること。
- 文書の WS 通知を受け、HTTP で内容を取得してプレビューが更新されること。
- ツール呼び出しの前でパックが閉じ、返信全体の終了を待たず同期できること。
- ハッシュ一致で確定し、不一致なら BE の全文へ置き換えて確定すること。
- BE が FE の確認前にパックを保存し、FE が順番に確定済み ID を進めること。
- 再接続後は途中の差分だけでも表示でき、終了時の照合で欠落を補完すること。
- 切断中に終了したパック、丸ごと未取得のパック、確定済みパックが一つもない場合を ID 列と HTTP 取得で同期できること。
- 同期中の差分・終了通知・HTTP 応答の重なりで、パックの欠落・重複・確定後の書き換えが起きないこと。
- 不正な入力、対象会話・プロジェクトの取り違えを拒否し、購読解除・切断で不要な監視を解放すること。
- 作成・送信を自動再送せず、応答が不明な操作を成功扱いしないこと。

既存のローカル接続制限と入力検証を維持します。入力、全文を返す応答、WS の送信待ちデータに用途別の上限を定めます。

既存テストを更新し、パックの照合・同期と実際の WS 接続のテストを追加します。最後に `bun run test` で全体を確認します。実サービスは使用しません。

## 完了条件

- 通常の HTTP API が維持され、対象のリアルタイム通信が共通 WS を使っている。
- チャットのパック単位の確定と再接続時の補完が動き、既存の会話履歴が保持されている。
- 不要になった SSE とその専用処理への依存が残っていない。
- 上記の検証が通り、マージ後の通信仕様と実装が一致し、下記のマージ前の決定事項が解消されている。

移行完了後、恒久的な情報が通信仕様に揃っていることを確認し、この計画と目次・ディレクトリ構成からのリンクを削除します。

## マージ前に確定すること

仕様文書はマージ後の契約として記述する。以下はまだ決まっていないため、文体を変えただけで解決済みとは扱わない。実装・マージ前に決定し、各仕様へ反映する。

- HTTP のパック API のパス・項目名、WS のメッセージ名・エラーコードの最終確認。
- Pack の本文・ツールデータの構造、ハッシュ対象・直列化規則・アルゴリズム。
- `/api/chat` と `/api/chat/send` の Conversation 応答とパックとの対応。HTTP 仕様の会話型は互換契約を引き継いでおり、最終的なパックとの関係を反映する必要がある。
- パック一覧のページング。導入する場合は確定済み ID とページ継続用カーソルを区別する。
- 受信サイズ、購読数、送信待ち量の上限、hello・購読のタイムアウト、再接続間隔、生存確認。
- 接続全体を閉じるエラーと個別購読だけを終了するエラー、WS close code。
- ツール呼び出し・結果を表すパックの構造。直前の本文パックを閉じる点は決定済み。
- 失敗・中断・サーバー再起動時に生成中パックを閉じる規則。正常終了と区別する。
- FE の確定データの保存先と保持期間。
- 既存の会話履歴からパックへの対応付け。既存データは削除しない。
