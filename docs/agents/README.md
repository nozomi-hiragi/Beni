# Agent インターフェース仕様

バックエンドがコーディングエージェントを実行する共通契約。操作・通信・保存形式は [LLM チャット連携](../features/llm-chat.md)、[チャットのパック同期](../communication/chat-sync.md)、[会話の保存](../data/beni/chat.md) に従う。

| 実装 | 登録 ID | 実行先 |
| --- | --- | --- |
| [CodexAgent](codex.md) | `codex` | インストール済み Codex CLI の App Server |
| [ClaudeAgent](claude.md) | `claude` | Claude Agent SDK とインストール済み Claude Code CLI |
| [DummyAgent](dummy.md) | `dummy`（テストの既定値） | テスト内のシナリオ |

## 登録と責務

バックエンドの起動時に `Agent` の一覧を `ChatService` へ渡す。登録 ID は1〜128文字とし、小文字の英数字から始まり、以降は小文字の英数字とハイフンで構成する。ID は実装の更新後も維持し、不正な ID や重複は起動時にエラーにする。送信先・モデル・コマンドの候補は登録情報と `getStatus()` から組み立てる。フロントエンドには、表示に必要な登録情報と状態だけを渡す。未登録の ID への送信は受付前に拒否し、保存済み履歴の表示にはその ID を残す。テストでは DummyAgent だけを登録できる。

登録ID・表示名と確認済みの接続情報・利用枠はアプリDBの [`agents`](../data/sqlite/README.md) にまとめる。`getStatus()` は初回、明示更新、接続情報の無効化後に呼び、通常の参照は保存値を使う。実行中の接続・認証・モデルの問題や、接続の結果不明を検出した場合は保存情報を無効化する。中断や圧縮対象がない場合など、接続情報に関係しない結果では無効化しない。送信処理の自動再送条件は変更しない。

| 担当 | 責務 |
| --- | --- |
| Beni | モデル選択、会話とフェーズの管理、履歴抜粋と指示の組み立て、作業範囲の決定、埋め込みツールの検証と実行、会話・パック・プロジェクトイベントの保存、画面への配信 |
| Agent | 実行環境と認証の確認、外部セッションの開始・再開、作業範囲の適用、SDK・CLI との通信、応答・ツール・終了状態の変換、中断と後始末 |

各実装が接続先の通信を扱い、`ChatService` は共通の型を使う。たとえば AntigravityAgent を追加するときは、同じ契約を実装して起動時の一覧に登録する。 [起動時の登録](../../src/backend/agents/index.ts) · [型定義](../../src/backend/agents/agent.ts)

## 型

TypeScript で契約を示す。`RateLimitUsage` は現行の共通型を再利用する。

```ts
type AgentId = string;
type AgentModel = { id: string; name: string };
type ContextUsage = { usedTokens: number; maxTokens: number };
type AgentSession = { agentId: AgentId; id: string; legacySessionId?: string };
type AgentTarget =
  | { mode: 'new' | 'ephemeral' }
  | { mode: 'resume'; session: AgentSession };
type AgentAccess = 'read-only' | 'workspace-write';

type AgentStatus = {
  availability: 'ready' | 'not-installed' | 'unsupported-version' | 'unavailable';
  auth: 'subscription' | 'api-key' | 'other' | 'none' | 'unknown' | 'not-required';
  models: readonly AgentModel[] | null;
  version?: string;
  executablePath?: string;
  checkedAt: string;
  accountKey?: string;
};

type AgentCommand = {
  name: string;
  description: string;
  kind: 'generation' | 'maintenance';
  requiresSession: boolean;
  aliases?: readonly string[];
  argumentHint?: string;
};

type AgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
type AgentToolResult = { ok: boolean; text: string };

type AgentRequest = {
  sendId: string;
  target: AgentTarget;
  modelId: string;
  cwd: string;
  access: AgentAccess;
  builtInTools: 'phase-default' | 'disabled';
  instructions: string;
  references: readonly string[];
  tools: readonly AgentTool[];
  resumeToolsChanged?: boolean;
  operation: { kind: 'send'; text: string }
           | { kind: 'command'; name: string; args: string };
};

type AgentUsage = {
  accountKey?: string;
  kind: 'snapshot' | 'window-update';
  usage: RateLimitUsage;
};

type AgentOutcome =
  | { status: 'completed'; output?: string }
  | { status: 'interrupted' }
  | { status: 'failed'; code:
      'unavailable' | 'model-unavailable' | 'session-missing'
      | 'session-incompatible' | 'unsupported' | 'rejected' | 'execution-failed'
      | 'compaction-unavailable' | 'nothing-to-compact' }
  | { status: 'unknown' };

type AgentEvent =
  | { type: 'accepted'; session: AgentSession | null }
  | { type: 'text.started'; itemId: string }
  | { type: 'text.delta'; itemId: string; delta: string }
  | { type: 'text.completed'; itemId: string; text: string }
  | { type: 'tool'; itemId: string; name: string; state:
      'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
      input?: string; output?: string; targetPaths?: readonly string[]; exitCode?: number }
  | { type: 'usage'; data: AgentUsage }
  | { type: 'context.usage'; data: ContextUsage };

interface AgentHost {
  signal: AbortSignal;
  emit(event: AgentEvent): Promise<void>;
  callTool(call: { id: string; name: string; input: unknown }): Promise<AgentToolResult>;
}

interface Agent {
  readonly id: AgentId;
  readonly name: string;
  readonly accessModes: readonly AgentAccess[];
  readonly supportsEmbeddedTools: boolean;
  readonly commands: readonly AgentCommand[];
  getStatus(): Promise<AgentStatus>;
  validateCommand?(command: { name: string; args: string }): boolean;
  run(request: AgentRequest, host: AgentHost): Promise<AgentOutcome>;
  getUsage?(): Promise<AgentUsage>;
  getContextUsage?(request: { session: AgentSession; modelId: string; cwd: string },
    signal: AbortSignal): Promise<ContextUsage | undefined>;
}
```

`getStatus()` は推論を起動せず、実行環境・認証・モデル候補を確認する。`models: null` は未確認、空配列は確認した候補がない状態を表す。Agent は実行環境と、その実装が許可する認証方式が使えるときに `ready` を返す。認証不要の Agent は `auth: 'not-required'` を返せる。Beni は実行先の可用性を `availability`、状態表示を `auth` から判定する。Agent は実行直前にも自身の認証条件を確認する。

## 実行と中断

1. Beni は送信先・モデル・コマンド・作業範囲を確認し、`sendId` を採番して送信を記録する。モデル一覧に載っていても実行時に拒否される場合がある。拒否は `model-unavailable` で区別する。
2. Agent は指定の作業場所・作業範囲・ツールを適用できることを確認し、開始または再開する。要求を受け付けたことを確認した時点で `accepted` を一度だけ送り、Beni は再開用の情報を保存する。プロセスの起動だけで受理と見なさない。本文とツールのイベントは受理後に渡し、利用枠の通知は受理前でも渡せる。
3. 同じ `run` の本文・ツールイベントは受信順に渡し、`emit` の処理完了を待つ。本文の開始・差分・確定は同じ `itemId` で対応づける。開始の通知がない場合は最初の差分または確定本文でパックを開く。確定本文が差分の連結と異なる場合、Beni はパックを閉じる前にその項目の本文を置き換える。ツールの開始と終了も同じ `itemId` を使う。Beni は項目をパックへ変換し、検証済みの操作対象や終了コードをプロジェクトイベントに記録する。
4. `run` はイベント配信を終えてから一つの終了結果を返す。中断は Beni が実行ごとの `signal` を abort して伝える。Agent は外部の中断手段を呼び、停止を確認してから `interrupted` を返す。結果が確認できなければ `unknown` とする。受理前の中断で未送信が確定していれば `interrupted` を返せる。
5. 確定した拒否や実行エラーは `failed`、送信した可能性があるまま応答を失った場合は `unknown` とする。Beni は `unknown` を自動再送しない。終了後の通知とツール呼び出しは破棄し、Beni が最終保存してから次の実行を許可する。

Beni は同じ会話への送信と保守操作を直列化する。Agent は別会話やバックグラウンドジョブの同時実行を `sendId` ごとに分離する。Beni が停止を求めた場合や、保存エラーで `emit` が失敗した場合も、Agent は担当する実行の接続とプロセスを閉じる。実行先が応答しない場合は既存の待機上限を適用し、受理や完了を確認できなければ `unknown` を返す。

## 履歴と再開

- Beni の会話 ID・送信 ID・パック ID と、接続先のセッション ID を分ける。`AgentSession.id` はその Agent だけが解釈し、Beni は会話とモデルの組で、引き継ぎ位置とともに保存する。再開時は指定された `agentId` と実装自身の ID が一致することを確認する。`new`・`resume` の受理には `AgentSession` を含める。`ephemeral` は接続先で再開用の履歴を永続化せず、受理では `session: null` を返す。
- 接続先の履歴に含まれていない発言や別フェーズからの引き継ぎは、Beni が範囲を絞って `references` に入れる。接続先の履歴一覧・メッセージ取得を Beni の履歴表示に使う必要はない。
- 通常送信や生成コマンドで、再開先が消失した、または現在のツール構成では再開できないと受理前に確定した場合は、`session-missing` または `session-incompatible` を返す。Beni は古い再開情報と引き継ぎ位置を無効にし、履歴の抜粋を作り直して、同じ `sendId` で新規セッションへ一度だけやり直せる。保存済みセッションを対象にした保守コマンドはその場で失敗とする。
- 既存の `threadId`・`sessionId` と接続先別の保存内容から `AgentSession` を復元する。従来の `threadId` に対応する値を `id`、併記されていた `sessionId` を `legacySessionId` として扱う。旧形式で接続先が省略されている場合は、従来どおり `codex` と読む。この既定値は旧データの読み取りに限定する。新しく保存する接続先には ID を明記し、既存の表示用履歴と ID は保持する。

## 作業範囲とツール

Beni はフェーズから `access` と組み込みツールの扱いを選び、Agent は実行環境に適用する。適用できなければ受理前に拒否する。現行の書き込み許可、ネットワーク制限、外部 MCP・フックなどの制限は [チャットの作業範囲](../features/llm-chat.md#タスク文書と作業範囲) と各実装の仕様に従う。

埋め込みツールを必要とする処理は、対応する Agent へだけ渡す。Agent は受け取った定義だけを登録し、進行中の実行からの呼び出しを `callTool` へ渡す。再開時の `resumeToolsChanged` は登録済みの定義と今回の定義の違いを伝える。実装ごとに再登録が必要かを判断する。Beni は名前・引数・対象プロジェクト・タスク・フェーズ・実行の有効性を検証する。ツール実行結果の成功・失敗は明示する。モデルからの入力、ツールの表示用出力、ファイル操作の対象パスは信用せず、パックとプロジェクトイベントの既存の保存上限・範囲検証を適用する。

## 任意機能と拡張

- **利用枠**。手動取得は `getUsage` の有無で判定し、明示的な更新時にだけ呼ぶ。会話中の更新は `usage` イベントで渡す。`snapshot` は取得した枠一覧で置き換え、`window-update` は同じラベルの枠だけを更新する。取得できなければ `usage: 'unknown'` を返し、同じアカウントの取得済みの値は保持する。Beni は `getStatus()` で確認した Agent ID と `accountKey` の組に一致する結果だけをキャッシュする。照合値が得られないときはキャッシュを使わず、アカウント切り替え前の通知は破棄する。`accountKey` は画面やチャット履歴に渡さない。
- **コンテキスト使用量**。受理済みのセッションで使用トークン数とモデルの上限を取得できたら、`context.usage` イベントで渡す。Beni は会話とモデルの組ごとに最後の値を保存する。圧縮の成功後は、その圧縮を反映した値だけを使う。保存済みセッションを個別に確認できる Agent は `getContextUsage` を実装し、チャットの送信や推論を行わずに値を取得する。
- **コマンド**。圧縮やレビューなどは、各 Agent が Beni から実行できるものを `commands` に宣言する。エージェント依存のコマンド定義はこの宣言に集約し、`GET /api/agents` の `commands` としてフロントエンドへ渡す。共有コードやフロントエンドに接続先別の対応表を重複して持たない。Beni は取得した候補の表示、別名の解決、名前・引数の共通制限・利用条件の検証、実行状態の保存を行う。圧縮対応も保守コマンドの `compact` の宣言で判定する。Agent には別名を解決した登録名を渡す。接続先固有の引数は Agent が検証し、`validateCommand` を提供する場合は Beni が受付前にも呼び出す。情報表示用の本文は `completed` の `output` に返し、通常の回答パックには含めない。生成コマンドの回答は通常の本文イベントで返す。圧縮の未対応や履歴不足は専用の失敗コードで区別する。履歴のアーカイブを行う `clear` など、Beni 内で完結する共通操作は Beni が定義・実行する。
- **今後の候補**。実行中の追加入力、セッションの分岐、画像入力、対話的な承認は、Beni の操作として採用した時点で型付きの任意機能として定義する。対応判定にはその機能の有無を使い、未対応を別操作で暗黙に代用しない。実行中の追加入力を採用する場合は、元の実行を識別し、通常の送信や新規ターンと区別する。

## 検証

DummyAgent だけを登録したチャットテストで、送信・履歴・イベント配信・中断・切断・再開を確認する。Codex と Claude の接続形式、起動設定、受理判定は、それぞれ既存の偽 CLI を使って確認する。接続先の選択肢・表示名・状態の取得には、登録情報を返す [HTTP API](../communication/http-api.md) を使う。既存の HTTP/WS と会話 JSON の形式で読めるように互換性を保つ。
