# Codex SDK・App Server の利用条件と認証

確認日 2026-11-07

Beni は利用者の実行環境にある Codex CLI の App Server を起動する。利用者は事前に `codex login` で自身の ChatGPT アカウントへサインインする。 [Codex の認証](https://learn.chatgpt.com/docs/auth)

## ライセンスと接続方式

Codex CLI と TypeScript 版 SDK `@openai/codex-sdk` は Apache-2.0 で公開されている。 [Codex リポジトリのライセンス](https://github.com/openai/codex/blob/main/LICENSE)

| 接続方式 | 実行の仕組み | 主な操作 |
| --- | --- | --- |
| TypeScript 版 SDK | `codex exec` を起動し、JSONL のイベントを受け取る | `startThread()`・`resumeThread()` で会話を開き、`run()`・`runStreamed()` で実行する |
| App Server | `codex app-server` を起動し、JSON-RPC で通信する | スレッドの開始・再開、応答の差分配信、中断、アカウント・利用枠の照会、動的ツール、レビュー |

TypeScript 版 SDK は自動化やアプリからのエージェント実行に使える。実行オプションには読み取り専用や作業フォルダーへの書き込みを選ぶ `sandboxMode` がある。会話クライアントでアカウント情報や動的ツールを扱う場合は、App Server が対応する RPC を提供する。 [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk#typescript-library) · [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 認証と利用枠

| 認証方法 | 利用枠・課金 |
| --- | --- |
| `codex login` で ChatGPT アカウントにサインイン | アカウントの Codex 利用枠。使えるモデルや機能はプラン・ワークスペースの設定に従う |
| OpenAI API キー | API 側の利用量に応じた課金 |

CLI は保存済みのログインを再利用する。TypeScript 版 SDK も CLI の非対話実行を通して認証する。 [Codex の認証](https://learn.chatgpt.com/docs/auth) · [非対話実行の認証](https://learn.chatgpt.com/docs/non-interactive-mode)

## 製品へ組み込む際の条件

OpenAI は、App Server の既存認証を使うローカルアプリや OSS が利用を継続できると案内し、Sign in with ChatGPT への移行を勧めている。商用またはホスティング型サービスに既存認証は使えず、Sign in with ChatGPT には別途、プレビューの利用資格・登録条件がある。 [App Server の認証](https://learn.chatgpt.com/docs/app-server#auth-endpoints) · [Sign in with ChatGPT のプレビュー条件](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## Beni での扱い

- バックエンドが検出済みの Codex CLI を App Server として起動し、標準入出力で通信する。
- `account/read` で ChatGPT 認証を確認する。明示的な利用枠の更新では `account/rateLimits/read` を呼び、会話中は `account/rateLimits/updated` を反映する。チャットの送信は ChatGPT 認証時に受け付け、認証情報の保持・更新は CLI に任せる。
- 会話の再開と応答の差分配信、埋め込みツール、`/review` に App Server の RPC を使う。通常ターンではフェーズに応じて読み取り専用または作業フォルダーに限定した書き込みを選び、ネットワークを無効にする。

[接続処理](../src/backend/chat.ts) · [LLM チャット連携](features/llm-chat.md)
