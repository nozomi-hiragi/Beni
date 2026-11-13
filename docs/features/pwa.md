# PWA と Tailscale

Beni はブラウザーからインストールして、独立したアプリウィンドウで開けます。サーバー側では従来どおり Beni を起動します。

## Tailscale の URL で起動する

サーバー側に Tailscale アプリと CLI を用意し、接続しておきます。閲覧する端末も同じ tailnet に接続します。初回またはコード変更後は `bun run build:exe` で実行ファイルを生成します。

```sh
bun run app --tailscale
```

表示された `https://…ts.net/` をブラウザーで開きます。コピーした実行ファイルも `./beni --tailscale` で同じように起動できます。

Tailscale モードでは以下を行います。

1. Tailscale の接続状態と自分のノードの DNS 名を取得します。
2. HTTPS の443番に競合する転送や Funnel がないことを確認します。別サービスの転送は上書きしません。
3. Beni を `127.0.0.1` で起動します。ポートが使用中なら、Serve の設定を変更せず終了します。
4. Tailscale Serve の HTTPS443番から Beni のポートへの転送を設定し、結果を確認します。同じ転送がある場合は再利用します。
5. 検出した HTTPS URL を表示します。HTTP API と WebSocket は、この公開ホストと Origin を既存の規則で検査します。

通常の `bun run app` では Tailscale の設定を検出・変更しません。Tailscale モードではポートに `1`〜`65535` を指定でき、既定は `3210` です。`BENI_PUBLIC_ORIGIN` を併用する場合は、検出した URL と一致する必要があります。

Tailscale が未接続、CLI が見つからない、Serve が使えない、既存設定と競合する場合はエラーで終了します。初回に HTTPS / Serve の有効化を求められた場合は Tailscale 側で設定してから再実行してください。

Serve は `--bg` で設定するため、Beni 終了後やマシン再起動後も転送設定が残ります。Beni 自体は自動起動しません。設定を確認するには `tailscale serve status` を使います。Beni の転送が不要になったら、443番が引き続き Beni 用であることを確認してから解除します。

```sh
tailscale serve --https=443 off
```

この公開は tailnet 内向けです。Funnel によるインターネット公開は設定しません。Beni 自体には認証機能がないため、接続できる端末は Tailscale のアクセス制御で管理します。Serve の仕様は [公式ドキュメント](https://tailscale.com/docs/reference/tailscale-cli/serve) を参照してください。

## インストールする

1. PC またはスマートフォンのブラウザーで Beni を開きます。別端末で使う場合は上記の HTTPS URL を使います。
2. 対応ブラウザーのインストールメニューから追加します。iPhone / iPad では「共有」→「ホーム画面に追加」を使います。
3. 追加された Beni のアイコンから起動します。

同じ端末内の `http://127.0.0.1:3210/` でも、対応ブラウザーでインストールできます。ローカル URL と Tailscale URL はブラウザー上で別アプリとして扱われるため、普段使う URL からインストールします。

アプリの名前、起動 URL、表示モード、アイコンは `/manifest.webmanifest` で定義します。マニフェストとアイコンは通常起動と実行ファイルの両方で配信します。

PWA のインストールはサーバーのインストールや自動起動ではありません。利用中はサーバー側の Beni と、必要な端末の Tailscale を起動しておきます。オフラインの読み書きや送信待ちキューは提供しません。Service Worker による画面・API・会話のキャッシュも行わず、新版への切り替え後は再読み込みで画面を更新します。現在のインストール要件については [MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) を参照してください。

## ソースから起動する場合

`--tailscale` は実行ファイルの起動オプションです。ソースから起動する場合は、従来どおり Serve と公開 URL を手動で設定できます。下記のホスト名は架空の例です。Serve が表示した自分の URL に置き換えます。

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3210
BENI_PUBLIC_ORIGIN=https://example-node.example-tailnet.ts.net bun run start
```

`BENI_PUBLIC_ORIGIN` に末尾の `/` やパスは付けません。`BENI_PORT` を変更した場合は Serve の転送先も合わせます。
