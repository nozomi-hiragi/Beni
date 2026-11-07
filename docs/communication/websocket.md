# WebSocket メッセージ仕様

WS の接続、購読、イベント、エラーの契約を定義します。

## 接続と役割

同一 origin の `/api/ws` にブラウザーのタブごとに一本接続します。Upgrade には GET を使い、ホストと Origin を検査します。ローカル接続は `127.0.0.1` と同一 Origin、Tailscale Serve 経由は `BENI_PUBLIC_ORIGIN` の host と HTTPS Origin の一致が必要です。`Sec-Fetch-Site: cross-site` の要求も拒否します。ホストの制限は HTTP と共通で、転送ヘッダーは判定に使いません。接続後はトピックごとに購読対象を検証します。

通常の作成・取得・変更は HTTP です。WS は購読管理、リアルタイム通知、ターミナル入出力を扱います。任意の HTTP 操作を呼ぶ RPC は用意しません。

## 接続の状態

`未接続 → 接続中 → バージョン確認中 → 利用可能 → 切断 → 再接続` を区別します。

1. FE が接続し、hello を送る。
2. BE が対応バージョンなら ready を返す。ready までは購読を受け付けない。
3. FE が必要な対象を購読し、subscribed を受け取る。
4. FE が HTTP で文書の最新内容やチャットのパック一覧を同期する。
5. 切断したら購読は失効する。再接続では hello と購読をやり直す。

非対応バージョンはエラーを通知して閉じ、自動再接続を繰り返さない。ネットワーク切断時は待機して再試行する。接続世代を区別し、古い接続のコールバックを新しい購読へ適用しない。

## 共通エンベロープ

一つの WS テキストメッセージに一つの JSON オブジェクトを入れます。全メッセージに `type` を付けます。バイナリ形式は現段階では定義しません。

| type | 方向 | 必須項目・意味 |
| --- | --- | --- |
| `hello` | FE → BE | `version`。希望するプロトコル版 |
| `ready` | BE → FE | `version`。利用可能になった版 |
| `subscribe` | FE → BE | `subscriptionId`, `topic`, `scope` |
| `subscribed` | BE → FE | `subscriptionId`。購読成立 |
| `unsubscribe` | FE → BE | `subscriptionId` |
| `unsubscribed` | BE → FE | `subscriptionId`。購読解除済み |
| `event` | BE → FE | `subscriptionId`, `name`, `data` |
| `error` | BE → FE | `code`, `message`。対象を特定できる場合は `subscriptionId` |
| `terminal.input` / `terminal.resize` / `terminal.takeover` | FE → BE | 個別シェルの `subscriptionId` と権限の `generation`。詳細は [ターミナル通信](terminal.md) |

`subscriptionId` は FE が作る接続内で一意な、1〜128 UTF-16コード単位の文字列です。パック ID とは別です。同じ対象を複数の画面部品が使う場合、FE の共通層で購読を共有します。

```json
{"type":"hello","version":1}
```

```json
{"type":"ready","version":1}
```

## 購読対象

| topic | scope | イベント |
| --- | --- | --- |
| `chat` | `{projectId: string, taskId: string \| null, phase?: string \| null}` | `chat.pack.delta`, `chat.pack.closed`, `chat.changed` |
| `task-events` | `{projectId: string, taskId: string}` | `task.events.changed` |
| `documents` | `{projectId: string, taskId: string}` | `documents.changed` |
| `terminal` | `{projectId: string, taskId: null, terminalId?: string}` | `terminal.changed`, `terminal.state`, 画面同期・入出力イベント |

General の `taskId` は null とします。インストラクション編集相談は `chat` トピックで `{projectId: 'instructions', taskId: null}` を指定します。文書は対象プロジェクトに属する現存タスクを指定します。ターミナルは `terminalId` を省略すると一覧、指定すると個別シェルを購読します。操作メッセージとイベントの詳細は [ターミナル通信](terminal.md) を参照してください。

```json
{"type":"subscribe","subscriptionId":"s1","topic":"chat","scope":{"projectId":"019a5000-0000-7000-8000-000000000001","taskId":"019a5000-0000-7100-8000-000000000002","phase":"requirements"}}
```

```json
{"type":"subscribed","subscriptionId":"s1"}
```

BE は購読を登録してから subscribed を送り、その後にその購読のイベントを送ります。チャット・文書は購読時の過去差分の送信がなく、初期状態をHTTPで取得します。ターミナルは購読成立後に一覧または端末画面の復元データを送ります。

接続内で使用済みの subscriptionId に対する subscribe は拒否し、対象の上書きには使いません。解除済み ID はその接続内で再利用しません。未知・解除済み ID への unsubscribe は解除済みとして応答します。

FE は画面から離れた時点でその購読のイベントを無視し、BE は解除処理後に unsubscribed を返します。それより前に送信済みのイベントが届いても、FE が終了した購読を復活させてはいけません。

PackHeader の形式は [HTTP API](http-api.md#パックの形式とハッシュ) を参照してください。差分ごとに header を付けるため、途中から受信してもパックの情報を復元できます。

## チャットの差分

```json
{"type":"event","subscriptionId":"s1","name":"chat.pack.delta","data":{"packId":"pack-example-1","delta":"説明の続きです。","header":{"packId":"pack-example-1","sequence":2,"messageId":"message-example-1","sendId":"send-example-1","role":"assistant","kind":"text","model":null,"createdAt":"2026-01-01T00:00:00.000Z","status":"streaming","state":"streaming"}}}
```

本文パックの data は `{packId: string, delta: string, header: PackHeader}` です。FE はパックの未確定本文へ順番に追記します。最初に受け取った差分で未確定パックを作れるため、接続し直した際にパック開始通知を再送する必要はありません。

差分の再送・再開位置を扱わないため、再送用の連番や offset は持たせません。同じ接続からの差分は受信順に処理します。途中で切れた内容はパック終了時の HTTP 照合で補完します。

## パック終了

```json
{"type":"event","subscriptionId":"s1","name":"chat.pack.closed","data":{"packId":"pack-example-1","header":{"packId":"pack-example-1","sequence":2,"messageId":"message-example-1","sendId":"send-example-1","role":"assistant","kind":"text","model":null,"createdAt":"2026-01-01T00:00:00.000Z","status":"completed","state":"closed"}}}
```

BE がパックを確定・保存したあとに送ります。同じパックの差分は、この通知以降には送信しません。終了はそのパックの区切りであり、返答全体の終了や FE の受け取り確定とは別です。

FE は HTTP の ack でハッシュ照合を行います。未受信のパックに対する終了通知なら、HTTP で全文を取得します。順序が不明な場合はパック ID 列を取得し、順番に確定します。二度届いた終了通知は同じパックを再確定させません。


## 会話の状態変更

`chat.changed` の data は `{}` です。送信受け付けや返答終了などで会話の実行状態が変わったときに送ります。FE は HTTP で会話の状態を更新し、送信可否や中断ボタンへ反映します。本文差分ごとにこの通知を送り、全文を再取得することはしません。

## 文書更新

```json
{"type":"event","subscriptionId":"s2","name":"documents.changed","data":{}}
```

対象は購読の scope で特定します。タスク文書の保存や文書ワークフローの状態変更を知らせ、FE は `GET /api/tasks/:id` で最新の内容を読み直します。取得中に再度通知された場合は、取得を終えてから最新状態を取得します。プロジェクトファイルのプレビューはファイル選択時に HTTP で取得します。

## エラーと切断

```json
{"type":"error","subscriptionId":"s1","code":"NOT_FOUND","message":"対象が見つかりません"}
```

| code | 対応 |
| --- | --- |
| `INVALID_MESSAGE` | JSON・型・必須項目が不正。または同期中のターミナル操作、終了済みシェルへの入力、古い世代での操作権取得などを拒否 |
| `UNSUPPORTED_VERSION` | ready を返さず接続を閉じる |
| `NOT_READY` | バージョン確認前の操作を拒否する |
| `UNKNOWN_TOPIC` | 未対応の購読を拒否する |
| `SUBSCRIPTION_CONFLICT` | 使用済み購読 ID を拒否する |
| `NOT_FOUND` | 対象なし・プロジェクトとの対応不正を拒否する |
| `FORBIDDEN` | ターミナルの操作権がない要求を拒否する |
| `LIMIT_EXCEEDED` | 購読などの上限超過を拒否する |
| `INTERNAL_ERROR` | 内部情報を含まないメッセージで失敗を伝える |

タスク変更履歴の初回取得に失敗した場合など、成立後の購読が継続できない場合は、その購読の `INTERNAL_ERROR` を通知して解除します。

遅い受信側へ送信待ちデータを無制限にためません。チャットの差分を黙って捨てて接続を継続することも避けます。上限を超えた接続は切断し、再接続後の HTTP 同期へ進めます。

## 機能を追加するとき

機能ごとに topic、scope の検証、イベント名、data の型と検証、購読開始・解除処理を定義します。共通層はその登録情報で振り分けます。HTTP で取得すべき初期状態・切断後の回復方法もセットで定めます。

ターミナルの FE → BE 操作は `terminal.input`・`terminal.resize`・`terminal.takeover` です。詳細は [ターミナル通信](terminal.md) に定義します。

## 上限とタイムアウト

| 項目 | 値・動作 |
| --- | --- |
| プロトコル版 | 1 |
| メッセージサイズ | 送受信とも64 KiB以内 |
| 送信待ち量 | 1 MiB以内。超過時は切断して再同期 |
| 同時購読数 | 接続ごとに32件 |
| 使用済み購読 ID | 接続ごとに4,096件。超過する購読要求では接続を閉じて再接続で更新 |
| BE の hello 待機 | 5秒 |
| FE の接続・購読成立待機 | 10秒 |
| BE の idle timeout | 30秒。WS ping で生存確認 |
| FE の再接続待機 | 1秒から倍増し最大30秒。ready でリセット |

本文差分は最大4,096 UTF-16コード単位ごとに分割し、サロゲートペアの途中では切りません。差分を結合すると元の文字列になります。

明示的に閉じるコードは、非対応版が1002、バイナリ受信が1003、hello タイムアウトが1008、送信フレーム超過が1009、送信待ち超過・購読 ID の更新が1013です。切断後はチャット・文書をHTTPで同期し、ターミナルは再購読して端末画面を復元します。

FE は不正な応答または `INTERNAL_ERROR` を受けたときに接続をやり直し、失敗を3回数えると自動再試行を止めてページ再読み込みを案内します。同じ接続で購読成立から30秒以上経過していれば、それまでの失敗回数をリセットして今回を1回目と数えます。通常のネットワーク切断は回数に加えません。

購読が一件もなくなった場合、FE は接続と再接続タイマーを閉じます。次に購読が必要になったときに接続を開きます。

## フェーズ別チャットと変更履歴

`chat` の scope はタスク会話で `{projectId, taskId, phase}` とする。`phase` は終了を含む6フェーズの識別子で、Generalはnullまたは省略する。購読共有・キャッシュ・再接続の対象はフェーズまで含めて分離する。他のトピックでは `phase` を省略する。

`task-events` は `{projectId, taskId}` を scope とし、タスク全体の変更を購読する。登録済みプロジェクトと形式上有効なタスク ID を指定でき、削除済みタスクの履歴も取得できる。購読成立時には、同じプロジェクトの現存タスクであれば最新の履歴を記録する。購読成立後の初回と以後の更新時に `task.events.changed` でカーソルを通知する。data は `{lastEventId: number}` で、`lastEventId` はプロジェクト共通のイベント ID。画面は必要なタスク状態と履歴を HTTP で取得する。詳細は [タスクの変更履歴](../objects/task-events.md#取得と通知の契約) を参照。
