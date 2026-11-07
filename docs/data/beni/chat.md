# .beni/chat の会話

保存仕様を定義します。

会話はバックエンドで永続化し、プロジェクトのジェネラル会話とタスクのフェーズごとの会話を区別します。JSONは人が直接開いて確認できる形式とします。

発言ごとに送信状態と順序付きのパートを保持し、接続先の会話識別子はモデルごとに記録します。送信ID・パックID・CLI側のセッションIDは用途を分けます。

バックエンドに保存した内容を正本とし、フロントエンドの受信内容はパック単位の照合後に確定します。完了を確認できない送信は自動再送しません。

会話はジェネラル・タスク会話とも対象プロジェクト直下の `.beni` に配置します。ジェネラルは `chat/general.json`、タスク会話は `chat/<taskId>/<phase>.json` に保存します。`taskId` は [共通ID規則](../README.md#idの共通規則) に従い、タスク情報と同じIDを使います。会話を公開リポジトリへ自動追加しません。

保存・更新の契約は [LLMチャット](../../features/llm-chat.md#チャット履歴の保存)、パックの形式と同期は [通信仕様](../../communication/chat-sync.md) を参照します。

[データ設計の全体像](../README.md)

## フェーズ別の保存

`phase` は `requirements`、`documents`、`implementation`、`execution`、`retrospective`、`finalization`。各会話は独立した会話IDと発言履歴を持ち、CLIセッションとイベントの確認済み位置をモデルごとに保持する。未送信のフェーズは空の会話として扱い、保存ファイルは必要時に作成する。Generalのphaseはnull。

| フェーズ | チャットファイル | 対応するタスク文書 |
| --- | --- | --- |
| 要件定義 | `requirements.json` | `requirements.md` |
| 仕様整理 | `documents.json` | `documents.md` |
| 実装手順 | `implementation.json` | `implementation.md` |
| 実装中 | `execution.json` | 専用文書なし |
| 反省会 | `retrospective.json` | `retrospective.md` |
| 終了 | `finalization.json` | 専用文書なし。反省会の内容を参照し、プロジェクトの `knowledge.md` を更新 |

変更イベントと本文の版は [タスクの変更履歴](../../objects/task-events.md) に従う。

再開したタスクを再び完了する場合は、前回の終了会話を同じタスクの `history/<会話ID>.json` に残し、新しい終了会話を作る。

## プロバイダ・モデルとメッセージ

保存形式は `version: 3` とする。`providers` は、この会話で使った接続先を登録 ID で引く辞書。各接続先の `name` は表示名で、`models` はその接続先が使うモデル ID をキーとする。モデルの `name` は履歴の表示に使う。選択中のモデルは `selectedModelId` に `接続先ID/モデルID` で記録し、未選択なら `null` とする。複合 ID は最初の `/` で区切る。

`messages` は共通の配列とする。発言ごとに Beni の `id`、送信をまとめる `sendId`、`role`、`modelId`、時刻、処理状態、`parts` を持つ。発言の `modelId` は `selectedModelId` と同じ形式で、`providers` 内のモデルを参照する。旧履歴にモデル ID がない発言は `modelId: null` とし、接続先は `providerId` に残す。

各パートは本文またはツール操作を表し、`packId` と会話全体での `sequence`、時刻、状態を保持する。発言 ID・送信 ID・発言者・接続先・モデルは親の発言から補い、保存済みパックの値が異なる場合は該当する項目をパートに保持する。旧パックで接続先が省略されていた場合は `provider: null` で表す。

発言全体の本文は、本文パートを順番につないで復元する。旧履歴の本文など、連結結果と異なる本文を保持する場合だけ `contentOverride` を記録する。HTTP・WebSocket 用のパックはパートから復元し、パック ID・順序・ハッシュを維持する。

```json
{
  "version": 3,
  "providers": {
    "claude": {
      "name": "Claude",
      "models": {
        "haiku": {
          "name": "Haiku",
          "session": { "resumeId": "example-session", "lastEventId": 0 },
          "messageData": {
            "example-message": { "resumeId": "example-session" }
          }
        }
      }
    }
  },
  "selectedModelId": "claude/haiku",
  "messages": [
    {
      "id": "example-message",
      "sendId": "example-send",
      "role": "assistant",
      "modelId": "claude/haiku",
      "parts": [
        {
          "packId": "example-pack",
          "sequence": 1,
          "kind": "text",
          "content": "こんにちは",
          "tool": null,
          "state": "closed",
          "status": "completed"
        }
      ]
    }
  ]
}
```

例では会話のスコープや時刻などを省略している。受理後にモデルが明示的に拒否された場合は、該当するアシスタントのメッセージに `errorCode: "MODEL_UNAVAILABLE"` を記録する。

## セッションと移行

再開情報は `providers[接続先ID].models[モデルID].session` に置く。接続先の `resumeId`、必要に応じて従来の `sessionId` に対応する `legacySessionId`、イベント確認済み位置 `lastEventId`、会話の引き継ぎ位置 `contextMessageCount`、ツールや指示の引き継ぎ状態を記録する。`lastEventId` は、対象のセッションが `acknowledge_events` で確認完了を通知したイベント ID の上限。

`session.contextUsage` は、同じセッションで最後に計測したコンテキスト使用量。取得できた場合に `usedTokens` と `maxTokens` を保存する。新しいセッションに切り替えるときや、圧縮に成功して計測値が届かなかったときはこの項目を外す。

発言当時の再開 ID と補助 ID は、該当モデルの `messageData` にメッセージ ID をキーとして保存する。モデルを特定できない旧発言の付加情報は、接続先直下の `messageData` に保存する。

同じ接続先でもモデルを変えたら別セッションを使う。以前のモデルへ戻ると、そのモデルのセッションを再開し、未共有の発言を抜粋して添える。受理前に再開先の消失や必要なツール構成との不一致が確定した場合は、同じ送信 ID で新規セッションを一度だけ試す。 [会話の引き継ぎ](../../features/llm-chat.md#フェーズ別の会話と変更の引き継ぎ)

`version: 1` と `version: 2` は読み取れ、次に保存したときに新形式へ変換する。旧形式で複数モデルが共有していたセッションは、最後にそのセッションを使ったモデルに引き継ぐ。モデルを特定できない旧セッションは接続先直下の `unassignedSession` に残し、その接続先のモデルを選んで送信したときに割り当てる。

## コマンドの状態

`command` は最新の保守操作を表す任意項目で、操作ID、名前、状態、失敗時の表示用情報を保存する。状態は `running`、`completed`、`failed`、`interrupted`、`unknown`。項目のない既存の会話は未実行として扱う。再起動後に実行継続を確認できない `running` は `unknown` にする。

圧縮するのはCLIがLLMへ渡すコンテキストであり、Beniの発言とパートは保持する。コマンド文字列や圧縮用の要約を通常の発言として追加しない。動作は [コンテキストウィンドウ](../../features/llm-chat.md#コンテキストウィンドウ)、取得と通知は [HTTP API](../../communication/http-api.md#チャットのコマンド) に従う。

情報表示コマンドの正常終了結果は `command.output` に保存する。`/clear` は、元の会話を同じ保存ディレクトリの `history/<会話ID>.json` へアーカイブしてから、新しい会話IDの空の履歴へ置き換える。アーカイブは通常ファイルのみとし、ディレクトリやファイルのシンボリックリンクを拒否する。タスク削除では、そのタスクのアーカイブも会話ディレクトリとともに削除する。生成を伴うコマンドの発言と回答は通常のメッセージ・パックとして保存する。
