# Beni

Bunで継続実行し、LinearのAgent Session WebhookをCloudflare Tunnel経由で受け取り、承認済みの作業をローカルのCodexで実行します。

## セットアップ

Bun 1.4.2以降、Git、Codexの認証済み環境、`cloudflared`が必要です。資格情報の保存には`Bun.secrets`を使います。OS固有の動作はまずmacOSで確認します。

```sh
bun install --frozen-lockfile
bun index.ts --help
```

Linearで自分のOAuthアプリを作成します。Redirect URIとWebhook URLは、後述の`publicBaseUrl`配下に揃えます。

- Redirect URI: `https://your-tunnel.example/oauth/callback`
- Webhook URL: `https://your-tunnel.example/webhooks/linear`

WebhookはAgent Session Event向けに設定し、署名検証用シークレットを控えます。認証はPKCEを使用するためClient Secretを設定ファイルへ書く必要はありません。

Cloudflare Tunnelを用意し、公開ホスト名をローカルの`127.0.0.1:oauthPort`（初期3456）へ転送します。リポジトリ直下の`.env.example`を参考に、作業ディレクトリへ`.env`を置きキーだけ設定します（値はリポジトリに入れない）。

```sh
# .env（キー名のみ。値は各自の環境へ）
BENI_CLOUDFLARE_TUNNEL_TOKEN=
BENI_LINEAR_WEBHOOK_SECRET=
```

リポジトリの外に`~/.config/beni/config.json`を作成します。`XDG_CONFIG_HOME`を設定している場合は、その下の`beni/config.json`が初期パスです。

```json
{
  "clientId": "YOUR_LINEAR_OAUTH_CLIENT_ID",
  "projectId": "YOUR_LINEAR_PROJECT_UUID",
  "publicBaseUrl": "https://your-tunnel.example",
  "maxConcurrent": 2,
  "taskTimeoutMs": 1800000,
  "maxContextRounds": 10
}
```

`publicBaseUrl`はHTTPSのoriginのみ（パス・クエリ・認証情報なし）です。OAuth Redirect URIとLinear Webhook URLの公開起点になります。`projectId`はLinearのプロジェクトUUIDです。対象のローカルディレクトリは引数で指定するか、そのルートで起動します。Gitに初回commitがあるリポジトリを指定してください。対象プロジェクトに未コミット変更があっても、実行の起点はcommit済みのHEADです。

```sh
# ブラウザでOAuthを許可する。トークンはOSの資格情報ストアに保存される
# （RedirectがpublicBaseUrl経由のため、Tunnelの転送先がoauthPortへ届く状態であること）
bun /path/to/beni/index.ts login /path/to/project

# フォアグラウンドで常時実行する（ローカルWebhook受信 + Tunnel起動）
bun /path/to/beni/index.ts /path/to/project

# 対象プロジェクトのルートで実行する場合
bun /path/to/beni/index.ts

# 別の設定ファイルを使う
bun /path/to/beni/index.ts /path/to/project --config /path/to/config.json

# 保存済み状態の確認と、接続解除
bun /path/to/beni/index.ts status /path/to/project
bun /path/to/beni/index.ts logout /path/to/project
```

`login`の待受は10分で終了します。`run`はCtrl+CまたはSIGTERMで停止します。自動デーモン化やOSのログイン項目の追加は行いません。

## 作業フロー

1. 登録プロジェクトでAgentにメンションまたは委任する。
2. LinearがWebhookを送り、BeniがTunnel経由で受け取り対象Sessionを処理する。情報の不足を質問するか、Backlogのサブイシューとして計画を提案する。
3. 依頼者がLinearで`/approve 1`など、表示された計画番号を承認する。自由文の承認・修正も解釈する。
4. サブイシューごとに専用のローカルブランチとworktreeで実装・検証し、commitして親ブランチへ順次統合する。
5. 親ブランチをレビューする。Beniはpush・GitHub PR作成・親イシューの完了を行わない。

`stop` signal、`/stop`、`stop`、`停止`を受けると実行中のCodexを中断します。再開は依頼者が`再開`または`/resume`と送信します。停止の検知はWebhook配信に依存します。

再起動時も実行途中だった処理は自動再開しません。計画への承認は最新の提案と結び付け、外部で工程の内容や依存関係が変更された場合は実行を止めます。部分的なAPI更新の後は同じ識別子を照合して重複を防ぎます。起動時に一度だけSession一覧の追いつき取得を行うことがありますが、定期ポーリングを主経路にはしません。

## 設定と保存先

追加の設定:

| 設定 | 用途 |
| --- | --- |
| `oauthPort` | ローカルHTTP待受（OAuthコールバックとWebhook）のポート。初期値3456 |
| `publicBaseUrl` | 公開HTTPS origin。Redirect URIとWebhook URLの起点。必須 |
| `model` | Codexのモデル。省略時は既存設定を使う |
| `dataDir` | DBとworktreeの保存先。初期値`~/.local/share/beni`。対象リポジトリの外に置く |
| `projects` | 複数対象の配列。各要素に`path`と`projectId`を指定する |

`projects`だけを指定する場合はトップレベルの`projectId`を省略できます。同じリポジトリへの作業は直列化し、別リポジトリは`maxConcurrent`まで並列で処理します。同じ保存先で複数プロセスは起動できません。

DBにはSession・処理済みActivityの識別子、承認・計画・実行状態、受信Webhookのキューなど復旧に必要な情報を保存します。全会話やAPI応答は保存しません。worktreeと完了記録は自動削除しません。Codex自身の履歴保存はCodexの設定に従います。

Codexの計画処理は読み取り専用、実行処理はworkspace-writeで動作します。実行時のネットワークは許可しますが、権限の自動昇格はしません。BeniはLinear更新を担当し、子Codexへの継承MCP・アプリ連携を無効化します。

## 検証

```sh
bun run typecheck
bun test

# 実際のCodex認証と利用枠を使う明示的な実行試験
bun scripts/smoke.ts
```

通常のテストは外部サービスを使わず、一時Gitリポジトリで承認、停止・再開、計画改訂、再起動、ローカル統合を確認します。`smoke.ts`は実際のCodexで加算関数とテストを作成し、親ブランチでテストを実行します。確認用ファイルは一時ディレクトリに残し、終了時に場所を表示します。この試験のLinear部分は模擬実装です。

**受信方式:** 通常運転はWebhook + Cloudflare Tunnelです。起動時の追いつき取得以外に、ポーリングを主経路にはしません。

## ドキュメント

- [アプリケーション動作フロー](docs/application-workflow.md)
- [確認事項への回答と実装方針](docs/implementation-questions.md)
- [Linear OAuth / PKCE](https://linear.app/developers/oauth-2-0-authentication)
- [Linear Agent Session](https://linear.app/developers/agent-interaction)
- [Linear Webhooks](https://linear.app/developers/webhooks)
- [Linear API制限](https://linear.app/developers/rate-limiting)
- [Codex SDK](https://developers.openai.com/codex/sdk)
- [Bunの資格情報ストア](https://bun.sh/docs/runtime/secrets)
