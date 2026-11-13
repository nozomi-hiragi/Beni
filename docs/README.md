# Beni のドキュメント

全体仕様は採用済みの方針を定義します。現行の操作・保存形式・通信契約は対応する仕様書を参照してください。採用済みで実装が残っている箇所は関連仕様に記載し、未決定の案は「今後の検討事項」にまとめています。

## 開発

- [ディレクトリ構成](directory-structure.md)
- [実行ファイルと自己開発](executable.md)
- [通信仕様・API](communication/README.md)
- [データ設計](data/README.md)
- [保存データの集約](data/storage.md)
- [Agent インターフェースと各実装の仕様](agents/README.md)
- [Codex SDK・App Server の利用条件と認証](codex-sdk.md)
- [Claude Agent SDK の利用条件と認証](claude-agent-sdk.md)

## 仕様

- [全体仕様](specification.md)
- [今後の検討事項（未決定）](future-considerations.md)
- [オブジェクト別の仕様と操作](objects/README.md)
- 画面
  - [ホーム画面](screens/home.md)
  - [プロジェクト詳細画面](screens/project-detail.md)
  - [プロジェクトの登録と作業場所](screens/project-settings.md)
  - [設定画面](screens/settings.md)
  - [データ画面](screens/data.md)
- 機能
  - [PWA と Tailscale](features/pwa.md)
  - [要求・根拠を追跡できる文書管理](traceable-documents-design.md)
  - [インストラクション管理](features/instructions.md)
  - [インストラクション編集画面のツール一覧（未実装）](features/instruction-tools.md)
  - [イベントに対応するワークフロー](features/workflows.md)
  - [LLM チャット連携](features/llm-chat.md)
  - [Navbar のツール](features/manual-tools.md)
  - [プロジェクト画面からのタスク追加](features/task-creation.md)
  - [タスク検索（未実装）](features/task-search.md)
  - [プロジェクト内ターミナル](features/terminal.md)

- [プロジェクトイベント管理](project-events/README.md)

`mockups/` は過去の画面案を残した静的な HTML と CSS です。現行の画面構成と操作は上記の画面仕様を参照してください。
