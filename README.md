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

複数起動については [動作条件](docs/next-agent-plan.md#動作条件) を参照してください。

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

アプリ側はプロジェクトの登録情報だけを、Beniルートの `data/beni.sqlite` に保存します。`BENI_DATA_DIR` でアプリ側の保存先を変更できます。相対指定は起動時の作業ディレクトリを基準にします。

タスク・文書・会話は対象プロジェクトの `.beni/` に保存します。プロジェクトを移すときは `.beni/` も一緒に移してください。

```text
Beni/data/
└── beni.sqlite                  プロジェクトの登録情報

<project>/.beni/
├── project.json                 プロジェクト情報の正本
├── chat/
│   ├── general.json             ジェネラル会話
│   └── <taskId>.json            タスク会話
└── tasks/<taskId>/
    ├── task.json                タスク情報
    ├── requirements.md
    └── implementation.md
```

`BENI_DATA_DIR` は `.beni/` の場所を変更しません。会話は平文で保存されます。実データを公開リポジトリへ追加しないでください。

旧形式のDBは非対応です。検出した場合は、内容を変更せず起動を停止します。

保存形式とIDの規則は [データ仕様](docs/data/README.md) を参照してください。

## 現在の機能

プロジェクトの名前とフォルダの登録、タスク作成、タスク別の会話保存、初期指示書の表示に対応しています。登録したフォルダの `.beni` からタスクを読み込み、文書だけ残っているタスクは `Unknown` として自動復元します。タスクの指示書は名前から初期化し、タスクの会話から更新できます。

プロジェクト内のターミナルで、サーバー側のシェルを実行できます。複数画面では一つだけが入力権を持ち、後から接続した画面は閲覧専用になります。「乗っ取る」で入力権を移せます。macOS・Linuxが対象です。

認証、利用枠、計画・実行、Gemma を使った検索は未接続です。検索は現在、タスク名と ID の簡易検索です。

## テスト

Bun に加えて Node.js 22.22.2 以上の22系、24.15.0 以上の24系、または26以上が必要です。UI テストは Node.js 上で実行し、Markdown のサニタイズを検証するテストでは jsdom を使います。

```sh
bun run test
```

- [仕様書](docs/README.md)
