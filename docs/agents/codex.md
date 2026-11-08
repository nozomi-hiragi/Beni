# CodexAgent 仕様

[Agent インターフェース](README.md) の実装仕様。登録 ID は `codex`。ローカルの公式 Codex CLI を `codex app-server` で起動し、標準入出力の JSON-RPC を実装内で扱う。 [App Server リファレンス](https://learn.chatgpt.com/docs/app-server)

## 接続状態と利用枠

- CLI の検出、バージョン確認、`initialize`、`account/read`、`model/list` を `getStatus()` にまとめる。モデル一覧は全ページを読み、モデル ID と表示名を返す。
- ChatGPT ログインを実行条件とする。API キーや別の認証方式は状態として区別する。認証操作は CLI 側で行う。 [利用条件と認証](../codex-sdk.md)
- `getUsage()` は `account/rateLimits/read` を呼ぶ。実行中の `account/rateLimits/updated` も `snapshot` に変換する。リセット時刻・使用率は取得できた枠だけ返す。キャッシュ用の照合値には既存の変換を使い、アカウントの生データは返さない。

## 会話とツール

| Agent の操作・イベント | App Server での処理 |
| --- | --- |
| 開始・再開 | `thread/start` / `thread/resume`。スレッド ID を再開用の `AgentSession.id` とする |
| 送信・受理 | `turn/start`。対象スレッドのターンが受理されたことを確認する |
| 本文とツール | 対象のスレッド・ターンを照合し、`item/agentMessage/delta`、`item/started`、`item/completed` を共通イベントに変換する |
| 中断・終了 | `turn/interrupt` を送り、対応する `turn/completed` と終了状態を確認する |
| 埋め込みツール | `dynamicTools` で登録し、対象ターンの `item/tool/call` を `AgentHost.callTool` に渡す |

旧形式の再開には `threadId` を使う。スレッドの消失を明示された場合は `session-missing`、ツール定義を登録し直すために新しいスレッドが必要な場合は `session-incompatible` を受理前に返す。`dynamicTools` は App Server の実験的機能であり、必要なツールを登録できないときは実行を拒否する。 [動的ツールの仕様](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental)

`read-only` と `workspace-write` を提供する。書き込みは Beni が指定した作業場所の範囲とし、ネットワークと権限昇格を無効にする。外部 MCP、アプリ、プラグイン、フックなどは現行の制限付き起動設定に従う。サーバーからの要求は、登録済みの埋め込みツールの呼び出しだけを受け付ける。

埋め込みツールを登録する場合は、読み取り専用のターンでも `code_mode_host` を有効にする。シェルの実行を制御する `shell_tool` は、作業フォルダーの書き込みと組み込みツールの使用を許可したターンで有効にする。

ターンのコンテキスト使用量は、App Server の `thread/tokenUsage/updated` に含まれる `last.totalTokens` と `modelContextWindow` を使う。対象スレッド・ターンの値を正常終了時に渡す。圧縮時は圧縮項目の完了後に届いた値を採用する。 [Codex App Server](https://learn.chatgpt.com/docs/app-server#turn-events)

保存済みセッションの計測値を更新するときは、App Server の `thread/read` で対象スレッドを照合し、ローカルの履歴から使用トークン数と上限を読み取る。対象モデルに対応する有効な計測記録を確認できた場合に値を返す。

## コマンド

| 登録名 | 種別 | 処理 |
| --- | --- | --- |
| `compact` | 保守、既存セッション必須 | `thread/compact/start` を呼び、対象ターンの開始を受理とする。圧縮項目とターンの正常終了を確認する |
| `review` | 生成 | `review/start` を `inline` で呼ぶ。対象省略時は未コミット差分、引数ありなら検証済みのレビュー指示を指定する |
| `recap` | 生成 | 要約用の依頼として通常のターンを開始する |

レビューの最終本文は `exitedReviewMode.review` から取得して本文イベントに変換する。同じレビュー本文を差分でも受け取った場合は一つの結果にまとめる。接続テストは通常のテキスト通知に加えてこのレビュー専用項目も使う。 [レビューの通知](https://learn.chatgpt.com/docs/app-server#review)

今後の拡張では、実行中の追加入力を `turn/steer`、会話分岐を `thread/fork` に対応づけられる。 [ターンとスレッドの操作](https://learn.chatgpt.com/docs/app-server)
