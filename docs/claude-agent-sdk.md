# Claude Agent SDK の利用条件と認証

確認日 2026-11-07

Beni は Claude Agent SDK から、利用者の実行環境にある公式 Claude Code CLI を呼び出す。利用者は事前に CLI で自身のアカウントへログインする。

## ライセンスとアプリへの組み込み

| 対象 | ライセンス・利用条件 |
| --- | --- |
| TypeScript 版 `@anthropic-ai/claude-agent-sdk` | Beni が使う npm 版 `0.3.292` の同梱 `LICENSE.md` は All rights reserved とし、Claude Code の利用条件を参照している。 [Claude Code の利用条件](https://code.claude.com/docs/en/legal-and-compliance) |
| Python 版 `claude-agent-sdk` | SDK のソースコードは MIT。CLI とサービスにはそれぞれの利用条件が適用される。 [LICENSE](https://github.com/anthropics/claude-agent-sdk-python/blob/main/LICENSE) |

Beni 本体は Apache-2.0 で公開し、npm の依存パッケージには提供元の利用条件が適用される。TypeScript 版の公式リポジトリの `LICENSE.md` は商用利用規約を参照している。 [Beni のライセンス](../LICENSE) · [TypeScript 版 SDK のライセンス](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md)

## SDK と CLI の連携

Agent SDK は Claude Code の実行ファイルを起動し、エージェントの実行、ツール呼び出し、会話の再開などをアプリから操作するためのライブラリである。 [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

```text
Beni → Claude Agent SDK → 公式 Claude Code CLI → Anthropic
```

TypeScript 版はプラットフォーム別の CLI 実行ファイルをオプション依存関係として配布している。`pathToClaudeCodeExecutable` を指定すると、別途インストールした CLI を使える。Beni は検出した CLI のパスを明示する。認証セッションの保持と更新、サービスとの通信は、その公式 CLI が担う。 [TypeScript リファレンス](https://code.claude.com/docs/en/agent-sdk/typescript)

## 認証方法ごとの利用枠

公式サポート記事は、認証方法ごとの消費先を次のように説明している。

| 認証方法 | Agent SDK・`claude -p` の消費先 |
| --- | --- |
| Claude プランでログイン | サブスクリプションの利用枠 |
| Claude Console の API キー | API の課金・クレジット |

2026-06-15 の更新では、SDK 利用に関する変更の一時停止と、第三者アプリを含む利用が従来のサブスク枠から消費されることが案内された。2026-10-07 の更新で案内された Max・Ultra・Team の月次 API クレジットは、連携した Claude Console 組織の API キーで実行する場合に適用される。Claude プランでログインして実行する場合は、引き続きサブスク枠を使う。 [Claude プランでの Agent SDK の利用](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

## 製品へ組み込む際の条件

Claude Code の公式資料は、個別の合意がある場合を除き、製品・サービスへの組み込みに商用利用規約への同意と次の条件を求めている。

- Anthropic が公開した実行ファイルを改変せずに使う。
- CLI に備わる認証方法を維持する。
- 各利用者が自身の API キー、Claude プラン、対応クラウドの資格情報のいずれかで認証し、提供元との契約に基づいて自身の利用分を負担する。

同資料では、製品提供者が利用料金を肩代わりしたり、Claude の利用を再販売・仲介したりすることを禁止している。 [Claude Code の製品への組み込み条件](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)

認証に関する節は、利用者が改変されていない Claude Code に自身でログインする場合と、第三者が利用者に代わってサブスクリプションの資格情報でリクエストを送る場合を区別している。SDK 概要では、第三者製品が `claude.ai` のログインや利用枠を提供する場合に事前承認を求めている。Beni の方式に対する個別の承認は未確認。 [認証と資格情報の扱い](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) · [Agent SDK の認証に関する案内](https://code.claude.com/docs/en/agent-sdk/overview#get-started)

## Beni での扱い

- 通常送信と生成コマンドでは SDK の `query()` に検出済み CLI を指定する。
- `auth status --json` で、Claude プランによるログインと接続先を確認する。
- Beni の起動環境に `ANTHROPIC_API_KEY` などの API 認証や別のプロバイダーが設定されている場合は、その状態を表示して Claude への送信を止める。
- 利用者が CLI でログインし、OAuth トークンは公式 CLI が管理する。Beni は CLI が返す認証状態を参照する。

対応する実装と仕様。 [接続状態の判定と送信処理](../src/backend/claude.ts) · [LLM チャット連携](features/llm-chat.md)
