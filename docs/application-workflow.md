# Beni のアプリケーション動作フロー

## 目的

Beni は Bun のコンソールアプリケーションとして継続実行し、Linear の Agent Session Webhook を Cloudflare Tunnel 経由で受け取り、ローカルプロジェクトに対する作業を Codex へ依頼します。本書では、Linear Agent API の操作モデルに沿って、依頼の受付、必要な情報の取得、計画の提案、ユーザーの承認、作業の実行、完了通知までの流れを整理します。

Linear の Agent API は Developer Preview であり、一般提供までに変更される可能性があります。実装時は最新の公式ドキュメントと SDK の型定義を確認します。

## 基本方針

- OAuthの`actor=app`で接続する。PKCEと`publicBaseUrl`経由のコールバックを使う。
- 通常運転はWebhook + Cloudflare Tunnel。ローカルで`127.0.0.1:oauthPort`にHTTPを開き、Tunnelで公開HTTPSへ届ける。
- `publicBaseUrl`はHTTPS origin必須。Redirect URIとLinear Webhook URLの公開起点とする。
- 対象は自分のapp userと登録済みLinearプロジェクトに限定する。
- 対象ローカルリポジトリは実行ディレクトリまたはパス引数で指定する。
- 会話の正本はLinearのAgent Activityとし、全イベントを保存しない。
- 計画の提示と明示的な承認を経てからCodexへ実作業を依頼する。
- サブイシューの成果はローカルで親イシューブランチへ統合し、人のレビューを待つ。

## 全体フロー

```mermaid
flowchart TD
    A[Webhook受信とSession取得] --> B{対象プロジェクトか}
    B -- はい --> C[イシューと会話を確認]
    C --> D{情報は十分か}
    D -- いいえ --> E[必要な情報だけ取得または質問]
    E --> A
    D -- はい --> F[Backlogサブイシューで計画を提案]
    F --> G[明示的な承認を待つ]
    G --> A
    A --> H{依頼者が最新計画を承認したか}
    H -- はい --> I[専用worktreeで工程を実行・検証]
    I --> J[ローカルcommitを親ブランチへ統合]
    J --> K{全工程が完了したか}
    K -- いいえ --> I
    K -- はい --> L[完了通知・親ブランチのレビュー待ち]
    A --> M{stopを検知したか}
    M -- はい --> N[中断して状態保存・再開指示待ち]
```

## 1. セットアップ

利用者自身のLinear OAuthアプリを用意し、`actor=app`で認可します。イシューの作成・更新とメンション・委任に必要な権限を要求します。トークンはOSの資格情報ストアへ保存し、SQLiteやリポジトリには保存しません。初期版は1ワークスペース・1端末の構成です。

Cloudflare TunnelとLinear Webhookを設定します。ローカルHTTPは`127.0.0.1:oauthPort`で受け、公開起点は`publicBaseUrl`です。認証コールバックも同じ公開起点配下（`/oauth/callback`）を使います。

## 2. Webhook受信とSession取得

Linearから`AgentSessionEvent`（created / prompted）のWebhookを受け取り、署名検証後にキューへ保存してACKします。処理側はSession IDからSDKの`agentSession`と`activities`で詳細を取得します。Activity IDを使って同じ入力の二重処理を防ぎます。初期コンテキストはSession・イシュー・関連コメントから取得します。

起動時に一度だけSession一覧の追いつき取得を行うことがありますが、定期ポーリングを主経路にはしません。Webhookキューが空の間はイベント待ちで待機します。

## 3. Agent Activity による対話と状態表示

Beni はコメントを直接的な進捗ログとして使うのではなく、Agent Sessionに次のAgent Activityを送信します。

| Activity | 用途 |
| --- | --- |
| `thought` | 依頼を受け付けたことや、現在確認している内容を短く伝える |
| `elicitation` | 不足情報、計画の確認、承認をユーザーへ求める |
| `action` | 情報取得、リポジトリ操作、テストなどの開始と結果を示す |
| `response` | 作業の完了、停止、または最終結果を伝える |
| `error` | 続行できない失敗と、ユーザーが取れる対応を伝える |

最後に送られたActivityに基づき、LinearがAgent Sessionを `pending`、`active`、`awaitingInput`、`complete`、`error`、`stale` のいずれかへ自動的に遷移させます。BeniはSession状態を独自に推測して手動更新しません。

ActivityはユーザーがAgentの状態をLinear上で確認できる粒度にします。ただし、シークレット、アクセストークン、不要な個人情報、秘匿すべきプロンプト、長大な内部推論はActivityやログへ出力しません。

## 4. 必要な情報の選択と取得

最初のCodex呼び出しでは実作業を行いません。まずSessionと関連イシューのコンテキストを確認し、作業計画を作るために十分な情報があるかを判定します。

Codexの判定結果には次を含めます。

- 判定: 情報が十分、Linearから追加取得が必要、またはユーザーへの質問が必要
- 追加取得が必要な場合: イシュー、コメント、親子イシュー、プロジェクトなどの種別と識別子
- 質問が必要な場合: 推測では決定できない不足事項

追加情報が必要な場合は、指定された識別子に対応するリソースだけを `@linear/sdk` から取得し、コンテキストへ加えて再判定します。すべてのLinearイベントを事前収集することや、ワークスペース全体をローカルへ複製することはしません。

### APIクライアントの選択

Linearとのデータ取得および更新には、型が付いた `@linear/sdk` を原則として使用します。Agent SessionとActivityの取得、Agent Activityの送信、イシューやコメントの取得、サブイシューの作成と更新もSDKを通して行います。これにより、GraphQLのクエリ文字列、変数、レスポンス型を個別に管理する処理を減らします。

使用中のSDKでまだ提供されていないDeveloper Preview機能が必要な場合、または必要なフィールドをSDKで取得できない場合に限り、Linear GraphQL APIを直接使用します。GraphQLを使う場合も取得範囲を必要なフィールドに限定し、SDKと同じ認証情報およびエラー処理の方針に従います。

ユーザーへの質問が必要な場合は `elicitation` Activityを送り、Sessionを入力待ちにします。回答のprompt ActivityをWebhookで検知したら、Agent Sessionに紐づくActivity一覧をAPIから取得して会話を復元します。通常のコメントは編集される可能性があるため、ユーザー入力の履歴には変更されないスナップショットであるAgent Activityを優先します。

## 5. ローカルで保持する最小限の状態

Linearを情報の正本とし、SQLiteには再起動からの復旧と重複実行防止に必要な情報だけを保存します。

- ワークスペースとBeniのapp user IDの対応
- Agent Session IDと対象イシューID
- 処理済みActivity ID
- 現在実行中のCodex処理と、その再開に必要な状態
- ユーザーによる計画の承認状態と、実行・復旧に必要な計画情報
- Beniが作成したサブイシューの識別子
- ローカルプロジェクトとLinearリソースの必要最小限の対応

Webhookの全ペイロード、全コメント、全イシュー更新は保存しません。再び必要になったLinear上の情報は識別子を使ってAPIから取得します。OAuthトークンやWebhookシークレットはSQLiteやソースコードへ保存せず、OSの安全な資格情報ストアなどから読み込みます。

## 6. 作業計画とサブイシューの作成

情報が十分になったら、Codexは作業を実行可能な単位へ分解します。各工程には次を含めます。

- 具体的な目的と完了条件
- 優先度
- 計画段階のステータス（原則としてBacklog）
- 他の工程にブロックされるかどうか
- 他の工程と並列実行できるかどうか

工程ごとに親イシュー配下のサブイシューを `@linear/sdk` で作成します。作成者がBeniであり、計画段階のBacklogにあるサブイシューだけを、計画修正の対象にできます。すでに実行を開始したものや完了したサブイシューは、計画を直す目的で書き換えません。

サブイシューを作成した後、`elicitation` Activityで提案内容を示し、ユーザーへ承認または修正を求めます。この時点ではリポジトリを変更しません。選択肢を提示する場合は `select` signalを利用できますが、自由文の回答もCodexで解釈します。

Agent Plan APIはSession内の進捗表示に利用できますが、Technology Previewであり仕様変更の可能性があります。永続的な作業管理にはサブイシューを使用し、Agent Planを必須の保存先にはしません。

## 7. 計画の確認と修正

Webhookで検知した依頼者のprompt Activityの回答をCodexが解釈します。

- **承認**: 計画を確定し、実行段階へ進む。
- **修正指示**: 指示に従い、Beniが作成した未着手のBacklogサブイシューだけを取消にし、改訂した計画のサブイシューを作成する。
- **追加情報**: コンテキストへ加え、必要であれば関連リソースをAPIから取得する。
- **不明確な回答**: `elicitation` Activityで確認し、承認されたものと推測しない。

修正後は再び `elicitation` Activityで計画を提示します。明確な承認をAgent Activityとして受け取るまでは、Codexに実作業を行わせません。

## 8. 承認後のタスク実行

承認後は、計画に記録した依存関係に従ってサブイシューを処理します。

1. 未完了で、ブロックされていないサブイシューを選ぶ。
2. `action` Activityで開始する操作をユーザーへ示す。
3. 同一リポジトリの工程は直列で処理し、別リポジトリの工程のみ設定した並列数まで実行する。
4. 依存工程があるものは、ブロッカーが完了してから開始する。
5. 各工程の専用ブランチ・worktreeで変更と検証を行い、ローカルcommitを親イシューブランチへ統合する。GitHubへのpush・PR作成は行わない。
6. 成功したサブイシューを完了にし、後続工程のブロックを解除する。
7. 続行できない失敗は `error` Activityで通知し、根拠なく後続工程を進めない。

計画外の作業が必要になった場合は、既存の完了済みサブイシューを変更しません。新しいサブイシューとして提案し、改めてユーザーの承認を得ます。

## 9. 停止、完了、追加変更

Webhookで `stop` signalを持つprompt Activity、または明示的な停止入力を検知した場合、Beniは実行中のCodexへ中断を要求し、新たなコード変更・Linear更新を停止します。進行中の外部操作を取り消せる保証はなく、結果を保存して再開時に照合します。安全に停止した後、`response`または`error` Activityで停止したことと現在の状態を知らせます。ユーザーから明確な再開指示を受けるまで処理を再開しません。

すべてのサブイシューが完了したら、Beniは `response` Activityで結果を通知します。親イシューを完了ステータスへ変更する最終判断はユーザーに委ねます。

完了後に追加変更が依頼された場合は、その変更をパッチ作業として新しいサブイシューにします。目的、優先度、依存関係を提示し、再びユーザーの承認を得てから実行します。これにより、完了した工程の履歴を保ったまま変更経緯を追跡できます。

## 状態遷移の要点

| Beniの処理段階 | Linear上の表現 | 次へ進む条件 |
| --- | --- | --- |
| Session受付 | `thought` Activity | 新規Sessionを検知して受付を通知 |
| 情報確認 | `thought`または`action` Activity | Sessionと必要なAPI取得結果を確認 |
| 情報待ち | `elicitation` Activity | prompt Activityでユーザー回答を検知 |
| 計画確認 | `elicitation` Activity | ユーザーが計画を明示的に承認 |
| 実行中 | `action` Activity | 依存工程を順次完了 |
| 失敗 | `error` Activity | ユーザーの追加指示または再試行条件を受信 |
| 停止 | `response`または`error` Activity | ユーザーから明確な再開指示を受信 |
| 完了 | `response` Activity | ユーザーが親イシューを完了、または追加変更を依頼 |

## 公式ドキュメント

- [Agent Interaction Guidelines](https://linear.app/developers/aig)
- [Agents: Getting Started](https://linear.app/developers/agents)
- [Developing the Agent Interaction](https://linear.app/developers/agent-interaction)
- [Interaction Best Practices](https://linear.app/developers/agent-best-practices)
- [Signals](https://linear.app/developers/agent-signals)
