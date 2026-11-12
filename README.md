# Beni

複数のコーディングエージェントを使い、依頼から計画・実行・監修までを支援するアプリケーションです。

## 現在の機能

- 作業フォルダーを登録し、ホームの一覧からプロジェクトやタスクを開けます。
- 要件定義、仕様整理、実装手順、実装中、反省会、終了の各フェーズを進められます。タスク文書の版・根拠・引用を確認し、反省会で得た知識をプロジェクトに引き継げます。 [プロジェクト詳細画面](docs/screens/project-detail.md)
- インストール・ログイン済みの Codex CLI と Claude Code CLI に接続できます。会話と実装担当のモデルを選び、会話を再開し、取得できた利用枠やコンテキスト使用量を確認できます。 [LLM チャット連携](docs/features/llm-chat.md)
- 作業フォルダー内のファイルを読み取り専用でプレビューできます。ターミナルではサーバー側のシェルを操作でき、複数画面の間で入力権を切り替えられます。ターミナルは macOS・Linux が対象です。 [ターミナル仕様](docs/features/terminal.md)
- インストラクションを管理し、タスク完了時のワークフローを設定できます。 [インストラクション管理](docs/features/instructions.md) · [ワークフロー](docs/features/workflows.md)
- Navbar の「ツール」から、表示中の対象に応じた Beni の埋め込みツールを直接実行できます。 [手動ツール](docs/features/manual-tools.md)
- データ画面で文書の過去版、チャット、タスク、イベント、エージェントの保存情報を閲覧できます。DB タブでは読み取り専用 SQL で検索・集計できます。 [データ画面](docs/screens/data.md)

## 起動

次の環境を用意します。

- PTY と drain 通知に対応した [Bun](https://bun.sh/) 1.4.3 以上。
- ビルド・UI テスト用の Node.js。22.22.2 以上の22系、24.15.0 以上の24系、または26以上。
- エージェントを使う場合は、公式 Codex CLI または Claude Code CLI をインストールし、自身のサブスクリプションのアカウントでログインします。対応条件は [LLM チャット連携](docs/features/llm-chat.md) を参照してください。

リポジトリを取得し、そのディレクトリで起動します。

```sh
git clone https://github.com/nozomi-hiragi/Beni.git
cd Beni
bun install
bun run start
```

**v0.2.0 は旧版とデータ互換性がありません。** 旧データの移行はサポートしません。旧版のデータ領域や作業フォルダー内の `.beni/` を引き継がず、新しい環境で利用を開始してください。

起動時に SolidJS の TypeScript と Tailwind CSS・daisyUI のスタイルをビルドします。

ブラウザーで http://127.0.0.1:3210/ を開きます。ポートは `BENI_PORT` で変更できます。

Beni のバックエンドは一つだけ起動します。一つのバックエンドへ複数のブラウザーや端末から接続できます。詳細は [動作条件](docs/specification.md#動作条件) を参照してください。

### Tailscale 経由で起動する

サーバー側と閲覧する端末を Tailscale に接続します。チャットのハッシュ確認にブラウザーの暗号 API を使うため、Tailscale Serve の HTTPS URL で開きます。

まずサーバー側で、HTTPS の443番から Beni の3210番への転送を有効にします。

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3210
```

表示された HTTPS URL を `BENI_PUBLIC_ORIGIN` に指定し、Beni のディレクトリで起動します。以下のホスト名は架空のサンプルなので、実際に表示されたものへ置き換えてください。末尾の `/` やパスは付けません。すでに Beni を起動している場合は、停止してからこのコマンドで起動し直します。

```sh
BENI_PUBLIC_ORIGIN=https://example-node.example-tailnet.ts.net bun run start
```

閲覧する端末で `https://example-node.example-tailnet.ts.net` を開きます。HTTPS の標準ポート443を使うため、URLにポート番号は不要です。IPアドレスへのHTTP接続ではなく、このHTTPS URLを使ってください。

`BENI_PUBLIC_ORIGIN` は起動したプロセスだけに適用される環境変数です。設定ファイルには保存されないため、次回も同じ指定で起動します。Beni 自体は `127.0.0.1:3210` で待ち受け、指定した公開ホストと Origin を許可します。`BENI_PORT` を変える場合は、Serve の転送先ポートも合わせます。

Serve の設定は `--bg` によりバックグラウンドで維持されます。確認と解除は次のコマンドで行います。解除しても Beni 自体は停止しません。

```sh
# 転送設定を確認
tailscale serve status

# HTTPS の転送を解除
tailscale serve --https=443 off
```

この手順は Tailscale 内向けの公開です。Beni 自体には認証機能がないため、接続できる端末は Tailscale のアクセス制御で管理します。

## データの保存先

Beni が管理するデータは、Beni ルートの `data/` にまとめて保存します。`BENI_DATA_DIR` で保存先を変更できます。相対指定は起動時の作業ディレクトリを基準にします。

- `beni.sqlite`: プロジェクト情報（ID・名前・日時・作業フォルダー）、インストラクションの版、更新ジョブと移行状態。
- `projects/<projectId>.sqlite` にタスク情報・文書・版・ナレッジ・イベントを保存します。
- `chats/<chatId>.json` に全用途の会話とアーカイブを保存します。所属とチャットIDの参照は `beni.sqlite` で管理します。

作業フォルダーがなくても、Beni のデータ領域に保存済みの文書・会話・履歴は閲覧できます。フォルダーを移した場合は、ホームでプロジェクトを選び「作業フォルダーを変更」から再指定します。

バックアップは Beni を停止してデータ領域全体を保存してください。`BENI_DATA_DIR` の変更だけでは既存データを移動しません。会話は平文で保存されるため、実データを公開リポジトリへ追加しないでください。

## テスト

型チェック、フロントエンドのビルド、バックエンドテスト、UI テストを実行します。チャットテストは偽エージェントを使うため、実際のアカウントは不要です。

```sh
bun run test
```

- [仕様書](docs/README.md)
