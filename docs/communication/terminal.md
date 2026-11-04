# ターミナルの通信と画面同期

シェルのライフサイクルと画面上の操作は [ターミナル仕様](../features/terminal.md) に定義します。この文書では、共通WS上の操作権と端末画面の同期を定義します。

## 購読

`terminal` topicを共通の `/api/ws` で購読します。`taskId` は必ず null です。

- `{projectId, taskId: null}`：プロジェクトのターミナル一覧を受信する。操作権は取得しない。
- `{projectId, taskId: null, terminalId}`：個別のシェルの画面と状態を受信する。操作権が空いていれば取得する。

バックエンドはプロジェクトの存在とセッションの所属を検査します。別プロジェクトのセッションIDを指定しても購読・操作できません。購読解除はシェルを終了しません。

## セッション情報

```ts
type TerminalSession = {
  id: string;
  projectId: number;
  requestId: string;
  status: 'running' | 'exited' | 'failed';
  exitCode: number | null;
  cols: number;
  rows: number;
};
```

`id` はシェルの識別子、`requestId` は作成要求の照合用IDです。WSの接続・購読IDとは別です。状態はバックエンド上で管理し、サーバーの再起動をまたいで復元しません。

## 操作権

バックエンドが、個別シェルの購読者のうち一つにだけ操作権を与えます。権限変更を `terminal.state` で通知します。

```ts
{session: TerminalSession, owner: boolean, generation: number, controlToken: string | null}
```

`owner` は受信する購読者自身が所有者かを表します。`generation` は操作権の世代です。`controlToken` はHTTP終了要求に使い、現在の所有者だけに渡します。権限移譲前に発行したトークンでシェルを終了させることはできません。

FEは、所有者であることと画面復元の完了を確認してから入力を有効にします。所有者でなくなったら入力とリサイズを止めます。バックエンドも入力ごとに購読者と世代を照合するため、通知が画面へ届く前に送信された古い権限の入力も拒否されます。

## FEからの操作

| type | 必須項目 | 動作 |
| --- | --- | --- |
| `terminal.takeover` | `subscriptionId`, `generation` | 「乗っ取る」に対応。旧権限を失効させて要求元へ移譲 |
| `terminal.input` | `subscriptionId`, `generation`, `data` | 現在の所有者からの入力をPTYへ渡す |
| `terminal.resize` | `subscriptionId`, `generation`, `cols`, `rows` | 現在の所有者の画面サイズをPTYへ反映 |

操作は成立済みの個別シェル購読を対象にします。切断や失敗時に入力を自動再送しません。操作権の移譲はシェル単位で直列に処理します。

## BEからのイベント

共通の `{type: 'event', subscriptionId, name, data}` 形式を使います。

| name | data | 用途 |
| --- | --- | --- |
| `terminal.changed` | `{sessions: TerminalSession[]}` | プロジェクトの一覧更新 |
| `terminal.state` | `{session, owner, generation, controlToken}` | シェルの状態と受信者の操作権 |
| `terminal.sync.begin` | `{sequence, cols, rows}` | 画面復元開始 |
| `terminal.sync.chunk` | `{data}` | 分割した復元用端末シーケンス |
| `terminal.sync.end` | `{sequence}` | 画面復元完了 |
| `terminal.output` | `{sequence, data}` | 後続の出力 |
| `terminal.resized` | `{sequence, cols, rows}` | 端末サイズの変更 |

シェル終了は `terminal.state` のstatusとexitCodeで通知します。出力本文はHTTPの一覧にも永続ログにも含めません。

## 画面同期の順序

バックエンドはPTY出力をheadless端末へ反映し、端末画面を復元できる形式でシリアライズします。共通WSの購読成立通知後に、begin・chunk・endの順で送ります。端末サイズも復元対象です。

復元用の画面と後続の出力を同じ処理列に載せ、画面取得中に発生した出力を取りこぼさないようにします。FEは復元終了後、sequenceの順に出力とリサイズを適用します。再接続時には過去の入力を送らず、同じシェルの画面を取り直します。

チャットのパック照合とは異なり、ターミナルは制御シーケンスによって画面全体が変化します。欠落した文字列をあとから単純に追記したり、途中からの出力だけで画面を復元済みと扱ったりしません。

## 上限とエラー

| 項目 | 上限・動作 |
| --- | --- |
| セッション数 | プロジェクトごとに8、サーバー全体で64。終了済み・失敗も閉じるまで含む |
| 作成要求ID | サーバー起動中に4,096件まで保持 |
| 端末サイズ | 20〜240列、5〜80行 |
| 入力メッセージ | UTF-8で4,096バイトまで。大きな貼り付けは送信せず表示で知らせる |
| 入力流量 | シェルごとに16,384バイトのバースト、毎秒16,000バイト補充 |
| PTY入力待ち | 65,536バイトまで。drain時に解放 |
| 出力処理待ち | シェルごとに2 MiBまで。超過時はエラー状態にしてシェルを終了 |
| スクロールバック | 200行 |
| 画面復元 | JSON化した画面データが256 KiBまで。超過時はスクロールバックを除いて再評価し、それでも超過ならエラーを表示して終了 |
| 出力・復元チャンク | 4,096 UTF-16コード単位まで。サロゲートペアの途中では分割しない |

これに加えて、共通WSのフレーム・送信待ち・購読数上限が適用されます。遅い受信者のWS切断ではシェルを終了せず、再購読で画面を復元します。

非所有者や古い権限での操作は `FORBIDDEN`、入力流量の超過は `LIMIT_EXCEEDED`、不正な操作や同期中・終了済みシェルへの入力は `INVALID_MESSAGE` を返します。拒否された入力は自動再送しません。

端末プログラムからの問い合わせ応答は、接続済みの操作画面がある間はその画面が返します。操作画面がない間はheadless端末が返し、二重応答を避けます。
