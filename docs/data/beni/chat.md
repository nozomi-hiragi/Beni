# .beni/chat の会話

保存仕様を定義します。

会話はバックエンドで永続化し、プロジェクトのジェネラル会話とタスクのフェーズごとの会話を区別します。JSONは人が直接開いて確認できる形式とします。

発言、送信状態、順序付きのパック列、接続先の会話識別子を保持します。送信ID・パックID・CLI側のセッションIDは用途を分けます。

バックエンドに保存した内容を正本とし、フロントエンドの受信内容はパック単位の照合後に確定します。完了を確認できない送信は自動再送しません。

会話はジェネラル・タスク会話とも対象プロジェクト直下の `.beni` に配置します。ジェネラルは `chat/general.json`、タスク会話は `chat/<taskId>/<phase>.json` に保存します。`taskId` は [共通ID規則](../README.md#idの共通規則) に従い、タスク情報と同じIDを使います。会話を公開リポジトリへ自動追加しません。

保存・更新の契約は [LLMチャット](../../features/llm-chat.md#チャット履歴の保存)、パックの形式と同期は [通信仕様](../../communication/chat-sync.md) を参照します。

[データ設計の全体像](../README.md)

## フェーズ別の保存

`phase` は `requirements`、`documents`、`implementation`、`execution`、`retrospective`。各会話は独立した会話ID・発言・パック列・CLIセッション・`lastEventId` を持つ。未送信のフェーズは空の会話として扱い、保存ファイルは必要時に作成する。Generalのphaseはnull。`lastEventId` はプロジェクトイベントについてLLMが確認完了を通知した上限であり、送信受付だけでは更新しない。

| フェーズ | チャットファイル | 対応するタスク文書 |
| --- | --- | --- |
| 要件定義 | `requirements.json` | `requirements.md` |
| 仕様整理 | `documents.json` | `documents.md` |
| 実装手順 | `implementation.json` | `implementation.md` |
| 実装中 | `execution.json` | 専用文書なし |
| 反省会 | `retrospective.json` | `retrospective.md` |

変更イベントと本文の版は [タスクの変更履歴](../../objects/task-events.md) に従う。

## 選択モデル

`selectedModel` は `{id: string, name: string, provider?: "codex" | "claude"}` または未設定の `null`。各フェーズとGeneralで独立して、送信を受け付けた際に保存する。選択だけの変更はフロントエンドで保持する。既存ファイルに項目がない場合は未設定として読む。IDは送信先の指定、表示名は利用可能な一覧から消えた場合の表示にも使う。メッセージ単位の使用モデルとは別に保持する。

受け付け後の明示的なモデル拒否は、該当するアシスタントメッセージの `errorCode: "MODEL_UNAVAILABLE"` として保存する。通常の失敗・結果不明にはこのコードを付けない。

## 接続先とセッション

メッセージの `provider` は `codex` または `claude`。`selectedModel.provider` と `sessionProvider` の省略は既存データとの互換のため `codex` として扱う。`sessionProvider` は現在のCLIセッションの接続先を示す。接続先を切り替えて送信するときはセッションIDをリセットし、保存済み本文を参考履歴として新しいセッションへ渡す。元のメッセージとパックは書き換えない。

CLIプロセスの起動成功だけではセッション成立・入力受理と見なさない。Claudeの初期化と入力受理を確認してからセッションを保存する。イベントの確認済み位置は、別途 `acknowledge_events` を受けたときだけ進める。新規起動が受理前に失敗した場合は仮のセッションIDを再開に使わず、次の明示的な送信で新規セッションを作る。

`eventToolsVersion: 1` は、イベント参照ツールを登録したセッションであることを示す。未登録のCodexセッションへツールを後付けせず、新しいセッションへ保存済み会話本文を引き継ぐ。

## コマンドの状態

`command` は最新のスラッシュコマンド操作を表す任意項目で、操作ID、名前、状態、失敗時の表示用情報を保存する。状態は `running`、`completed`、`failed`、`interrupted`、`unknown`。項目のない既存の会話は未実行として扱う。再起動後に実行継続を確認できない `running` は `unknown` にする。

圧縮するのはCLIがLLMへ渡すコンテキストであり、Beniの `messages` と `packs` は保持する。コマンド文字列や圧縮用の要約を通常の発言として追加しない。動作は [スラッシュコマンド](../../features/llm-chat.md#スラッシュコマンド)、取得と通知は [HTTP API](../../communication/http-api.md#チャットのコマンド) に従う。

情報表示コマンドの正常終了結果は `command.output` に保存する。`/clear` は、元の会話を同じ保存ディレクトリの `history/<会話ID>.json` へアーカイブしてから、新しい会話IDの空の履歴へ置き換える。アーカイブは通常ファイルのみとし、ディレクトリやファイルのシンボリックリンクを拒否する。タスク削除では、そのタスクのアーカイブも会話ディレクトリとともに削除する。生成を伴うコマンドの発言と回答は通常のメッセージ・パックとして保存する。
