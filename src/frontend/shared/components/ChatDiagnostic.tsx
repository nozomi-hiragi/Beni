import { Show } from 'solid-js';
import type { ChatDiagnostic } from '../../../shared/chat-diagnostic';
import type { ChatMessage } from '../types';

const stageLabel: Record<ChatDiagnostic['stage'], string> = {
  preparation: '送信の準備', spawn: 'CLI の起動', initialize: 'CLI との接続の初期化',
  'config-probe': '初期設定の読み取り', 'config-read': '適用後の設定の読み取り',
  'config-validation': '設定の安全性確認', account: 'アカウントの確認',
  'thread-start': '新しい会話の開始', 'thread-resume': '保存済みの会話の再開',
  'turn-start': '応答の開始', 'turn-completion': '応答の完了確認',
  host: 'Beni での応答の処理', agent: 'エージェントの実行', recovery: '保存済みの会話の復元',
};
const reasonLabel: Record<ChatDiagnostic['reason'], string> = {
  unavailable: 'CLI を利用できませんでした。', 'invalid-request': 'この条件では要求を実行できませんでした。',
  'spawn-failed': 'CLI を起動できませんでした。', timeout: '応答が時間内に届きませんでした。',
  'connection-closed': 'CLI との接続が閉じました。', 'rpc-rejected': 'CLI が要求を拒否しました。',
  'thread-in-use': 'この会話は別のアプリまたはプロセスで使用中です。そちらで会話を閉じ、少し待ってから再送してください。',
  'unsafe-config': 'Beni が必要とする安全設定を確認できませんでした。',
  authentication: '必要なアカウント認証を確認できませんでした。',
  'invalid-response': 'CLI からの応答を確認できませんでした。',
  'execution-failed': '処理中にエラーが発生しました。',
  'event-delivery-failed': 'Beni が応答イベントを処理できませんでした。',
  unconfirmed: '処理の結果を確認できませんでした。',
  recovered: '保存済みの会話に完了結果が記録されていませんでした。',
};

export function DiagnosticDetails(props: { diagnostic: ChatDiagnostic; sendId: string; updatedAt?: string }) {
  const rows = () => {
    const { stage, reason, failureCode, rpcCode, exitCode, signal, spawnError, configChecks } = props.diagnostic;
    return [
      `段階 ${stageLabel[stage]} (${stage})`, `理由 ${reason}`,
      failureCode && `失敗コード ${failureCode}`, rpcCode !== undefined && `RPC コード ${rpcCode}`,
      exitCode !== undefined && `プロセス終了コード ${exitCode}`, signal !== undefined && `終了シグナル ${signal}`,
      spawnError && `CLI 起動エラー ${spawnError}`,
      configChecks?.length && `確認できなかった設定 ${configChecks.join(', ')}`,
      `送信 ID ${props.sendId}`, props.updatedAt && `記録時刻 ${props.updatedAt}`,
    ].filter(Boolean).join('\n');
  };
  return <details class="mt-1 text-xs">
    <summary class="cursor-pointer">診断の詳細</summary>
    <pre class="mt-1 whitespace-pre-wrap wrap-anywhere select-text">{rows()}</pre>
  </details>;
}

export default function MessageDiagnostic(props: { message: ChatMessage }) {
  const explanation = () => {
    const { diagnostic, errorCode, status } = props.message;
    if (errorCode === 'MODEL_UNAVAILABLE') return '選択したモデルを利用できませんでした。';
    if (!diagnostic) return status === 'unknown' ? '応答の結果を確認できませんでした。' : '応答に失敗しました。';
    if (diagnostic.reason === 'thread-in-use') return reasonLabel[diagnostic.reason];
    const stage = stageLabel[diagnostic.stage];
    return `${status === 'unknown' ? '結果不明。' : ''}${stage}で問題が発生しました。${reasonLabel[diagnostic.reason]}`;
  };
  return <div class="text-sm" classList={{ 'mt-2': !!props.message.content }}>
    <p>{explanation()}</p>
    <Show when={props.message.diagnostic} fallback={<p class="text-xs text-base-content/60">この応答の診断情報は記録されていません。</p>}>
      {diagnostic => <DiagnosticDetails diagnostic={diagnostic()} sendId={props.message.sendId} updatedAt={props.message.updatedAt} />}
    </Show>
  </div>;
}
