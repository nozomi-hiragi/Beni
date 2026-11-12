# Beni

複数のコーディングエージェントを使い、依頼から計画・実行・監修までを支援するアプリケーションです。

## 起動

PTYとdrain通知に対応した [Bun](https://bun.sh/) 1.4.3以上を用意して、このディレクトリで実行します。

```sh
bun install
bun run start
```

起動時に SolidJS の TypeScript と Tailwind CSS・daisyUI のスタイルをビルドします。

ブラウザーで http://127.0.0.1:3210/ を開きます。ポートは `BENI_PORT` で変更できます。

複数起動については [動作条件](docs/specification.md#動作条件) を参照してください。

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

旧用途別のチャットが残っている場合は、Beniを停止して `bun src/backend/migrate-chats.ts` を実行してください。検証後に旧チャットを削除します。[チャット管理と移行](docs/data/chat-management.md)

旧 `task.json` が残っている場合は、Beniを停止して `bun src/backend/migrate-tasks.ts` を実行してください。タスク情報をプロジェクトDBに保存して検証後、旧JSONと空のタスクフォルダーを削除します。[タスク情報のDB集約](docs/data/task-management.md)

旧 `projects/<projectId>/project.sqlite` は、Beniを停止して `bun src/backend/migrate-projects.ts` で移行します。旧チャット・タスクJSONもある場合は、プロジェクトDB → チャット → タスクJSONの順に移行してください。確認後に旧DBと空のプロジェクトフォルダーを削除します。

旧プロジェクトの `.beni/` は起動時に移行します。移行先を検証して確定した後、変更のない旧管理データを自動削除します。移行失敗や移行元の変更を検出した場合は旧データを残します。管理外のファイルは削除しません。詳細は [保存構成と移行](docs/data/storage.md) を参照してください。

作業フォルダーがなくても、移行済みの文書・会話・履歴は閲覧できます。フォルダーを移した場合は、ホームでプロジェクトを選び「作業フォルダーを変更」から再指定します。

バックアップは Beni を停止してデータ領域全体を保存してください。`BENI_DATA_DIR` の変更だけでは既存データを移動しません。会話は平文で保存されるため、実データを公開リポジトリへ追加しないでください。

旧試作のアプリ DB は検出時に起動を停止します。移行した旧 Markdown は初回参照時に取り込みます。[SQLite の互換条件](docs/data/sqlite/README.md#db構成)

## 現在の機能

- 作業フォルダーを登録し、ホームの一覧からプロジェクトやタスクを開けます。旧 Markdown だけ残っているタスクは `Unknown` として復元します。
- 要件定義、仕様整理、実装手順、実装中、反省会、終了の各フェーズを進められます。タスク文書のプレビューで版と根拠を確認でき、作業フォルダー内のファイルも読み取り専用で開けます。 [プロジェクト詳細画面](docs/screens/project-detail.md)
- インストール・ログイン済みの Codex CLI と Claude Code CLI に接続できます。会話や実装担当のモデルを選び、設定画面で接続状態と取得できた利用枠を確認できます。 [LLM チャット連携](docs/features/llm-chat.md)
- ターミナルでサーバー側のシェルを操作できます。複数画面で開いた場合は一画面が入力権を持ち、「乗っ取る」で入力権を移せます。macOS・Linux が対象です。 [ターミナル仕様](docs/features/terminal.md)

## テスト

Bun に加えて Node.js 22.22.2 以上の22系、24.15.0 以上の24系、または26以上が必要です。UI テストは Node.js 上で実行し、Markdown のサニタイズを検証するテストでは jsdom を使います。

```sh
bun run test
```

- [仕様書](docs/README.md)
