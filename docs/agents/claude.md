# ClaudeAgent 仕様

[Agent インターフェース](README.md) の実装仕様。登録 ID は `claude`。通常送信・生成は TypeScript の Claude Agent SDK を使い、検出済みの公式 Claude Code CLI を `pathToClaudeCodeExecutable` に指定する。移行の基準は現行の SDK `0.3.292` と CLI `2.1.292` 以降。保守コマンドは CLI の非対話モードを使う。 [SDK リファレンス](https://code.claude.com/docs/en/agent-sdk/typescript)

## 接続状態と利用枠

- CLI の検出、対応バージョン、`auth status --json` を `getStatus()` にまとめる。`claude.ai` かつ `firstParty` のログインを実行条件とし、モデル候補は現行の `sonnet`、`opus`、`haiku` とする。実行時のモデル拒否は `model-unavailable` で返す。 [利用条件と認証](../claude-agent-sdk.md)
- `getUsage()` は、履歴を保存しない一時セッションで CLI の `/usage` を実行し、構造化結果を `snapshot` に変換する。これを取得できなかった場合に限り、短い SDK リクエストで利用枠イベントを確認し、取得した枠を `window-update` として返す。この確認は推論を伴う。
- 会話中の `rate_limit_event` は取得できた枠だけを `window-update` として渡す。アカウント切り替え後は前のアカウントの結果を使わない。利用枠と会話コンテキストの消費量は別に扱う。

## 会話とツール

| Agent の操作・イベント | SDK または CLI での処理 |
| --- | --- |
| 開始・再開 | `query()` の `sessionId` / `resume`。一時セッションには `persistSession: false` を指定する |
| 送信・受理 | SDK のストリームで対象セッションの実行を確認する。通常送信・生成では `system/init` だけで受理せず、応答の開始または正常終了を待つ |
| 本文とツール | 部分応答、確定ブロック、ツール実行と結果を共通イベントに変換する |
| 中断・終了 | SDK は `Query.interrupt()`、保守 CLI はシグナルで停止する。結果またはプロセス終了で停止を確認する |
| 埋め込みツール | `createSdkMcpServer()` にその実行のツールを登録し、`AgentHost.callTool` に渡す |

旧形式では Claude のセッション ID を復元する。再開対象の消失を受理前に明示されたときだけ `session-missing` を返す。SDK から受け取った応答は Beni のイベントに変換する。

`read-only` と `workspace-write` を提供する。`restricted`・`safe-mode`、設定読み込みの制限、許可ツールの絞り込みを維持する。組み込みツールを無効にした実行では Beni が渡した埋め込みツールのみ使う。保守コマンドではツールを無効にする。書き込みとコマンド実行は CLI のサンドボックスで制限し、サンドボックスが使えなければコマンド実行を拒否する。 [Claude の接続方式と隔離範囲](../features/llm-chat.md#claude-code)

## コマンド

| 登録名 | 種別 | 処理 |
| --- | --- | --- |
| `compact` | 保守、既存セッション必須 | CLI の `/compact` を実行し、手動の `compact_boundary` と正常終了を確認する |
| `context` / `usage` | 保守、既存セッション必須 | CLI のローカル出力と正常終了を確認し、結果本文を返す。`cost`・`stats` は `usage` の別名 |
| `review` / `code-review` | 生成 | SDK で `/code-review` を実行する |
| `simplify` / `security-review` / `recap` | 生成 | SDK で対応する組み込みコマンドを実行する |

チャットの `usage` と設定画面からの `getUsage()` は別の操作とする。チャットの情報表示は現行のローカル結果の判定を引き継ぎ、設定画面での更新だけが一時セッションで実行できる。 [LLM チャット連携のスラッシュコマンド](../features/llm-chat.md#スラッシュコマンド)

生成コマンドには通常送信と同じ作業範囲を適用し、クラウド実行や外部投稿を指定する引数は拒否する。通常送信では組み込みのスラッシュコマンドを無効にする。 [SDK でのコマンド実行](https://code.claude.com/docs/en/agent-sdk/slash-commands)

今後の拡張では、会話分岐を SDK の `forkSession()` に対応づけられる。コンテキストの構造化データを画面で使う場合は、対応する SDK バージョンの `getContextUsage()` を候補とする。 [SDK リファレンス](https://code.claude.com/docs/en/agent-sdk/typescript)
