import { createSignal } from 'solid-js';
import { api } from './api';
import type { ClaudeStatus, CodexStatus, Model, Provider } from './types';

type Selection = Model & { rejected?: boolean };
type Status = CodexStatus | ClaudeStatus;
const [statuses, setStatuses] = createSignal<Partial<Record<Provider, Status>>>({});
const [revision, setRevision] = createSignal(0);
const attempted = new Set<Provider>();
const inflight = new Map<Provider, Promise<void>>();
const manualInflight = new Map<Provider, Promise<void>>();
const statusRevision = new Map<Provider, number>();
const selections = new Map<string, Selection>();
const providers: Provider[] = ['codex', 'claude'];
export const modelScope = (projectId: string, taskId?: string, phase?: string) => `${projectId}:${taskId ?? 'general'}:${phase ?? ''}`;
export const providerName = (provider: Provider = 'codex') => provider === 'claude' ? 'Claude' : 'Codex';
export const modelLabel = (name: string, provider: Provider = 'codex') => `${providerName(provider)}/${name}`;
export const modelValue = (model: Model) => `${model.provider ?? 'codex'}:${model.id}`;
export const modelStatus = (provider: Provider = 'codex') => statuses()[provider];
export const providerReady = (provider: Provider = 'codex') => {
  const status = modelStatus(provider);
  return status?.auth === (provider === 'claude' ? 'claude' : 'chatgpt');
};
export const availableModels = (): Model[] => providers.flatMap(provider => modelStatus(provider)?.models?.map(model => ({...model, provider})) ?? []);
export function selectedModel(scope: string): Selection | undefined {
  revision();
  if (!selections.has(scope)) {
    try {
      const value = JSON.parse(localStorage.getItem(`beni:model:${scope}`) ?? 'null');
      if (value && typeof value.id === 'string' && value.id && typeof value.name === 'string' && (value.provider === undefined || providers.includes(value.provider))) selections.set(scope, {...value, provider: value.provider ?? 'codex'});
    } catch { /* 保存できない環境でもセッション中の選択は保持する。 */ }
  }
  return selections.get(scope);
}
export function chooseModel(scope: string, model: Selection) {
  const value = {...model, provider: model.provider ?? 'codex'};
  selections.set(scope, value);
  try { localStorage.setItem(`beni:model:${scope}`, JSON.stringify(value)); } catch { /* メモリ上の選択を使う。 */ }
  setRevision(value => value + 1);
}
export function rejectModel(scope: string, id: string, provider: Provider = 'codex') {
  const selected = selectedModel(scope);
  if (!selected?.rejected && selected?.id === id && (selected.provider ?? 'codex') === provider) chooseModel(scope, {...selected, rejected: true});
}
export function modelIsAvailable(scope: string) {
  const selected = selectedModel(scope);
  return !!selected && !selected.rejected && providerReady(selected.provider) && !!modelStatus(selected.provider)?.models?.some(model => model.id === selected.id);
}
function loadProvider(provider: Provider, force: boolean): Promise<void> {
  const manualPending = manualInflight.get(provider);
  if (manualPending) return manualPending;
  const pending = inflight.get(provider);
  if (pending) return pending;
  if (attempted.has(provider) && !force) return Promise.resolve();
  attempted.add(provider);
  const revision = (statusRevision.get(provider) ?? 0) + 1;
  statusRevision.set(provider, revision);
  const rejectedAtStart = new Map([...selections].filter(([, selected]) => selected.rejected && (selected.provider ?? 'codex') === provider));
  const request = api<Status>(`/api/${provider}/status`).then(value => {
    if (statusRevision.get(provider) === revision) applyStatus(provider, value, rejectedAtStart);
  }).finally(() => { inflight.delete(provider); });
  inflight.set(provider, request);
  return request;
}
function applyStatus(provider: Provider, value: Status, rejectedAtStart: Map<string, Selection>) {
  setStatuses(previous => ({...previous, [provider]: value}));
  for (const [scope, selected] of rejectedAtStart) {
    if (selections.get(scope) === selected && value.auth === (provider === 'claude' ? 'claude' : 'chatgpt') && value.models?.some(model => model.id === selected.id)) chooseModel(scope, {id: selected.id, name: selected.name, provider});
  }
}
// 設定画面の明示的な更新。GETの進行中リクエストとは共有せず、POSTの結果を同じ状態キャッシュへ反映する。
export function refreshProviderStatus(provider: Provider): Promise<void> {
  const pending = manualInflight.get(provider);
  if (pending) return pending;
  attempted.add(provider);
  const revision = (statusRevision.get(provider) ?? 0) + 1;
  statusRevision.set(provider, revision);
  const rejectedAtStart = new Map([...selections].filter(([, selected]) => selected.rejected && (selected.provider ?? 'codex') === provider));
  const request = api<Status>(`/api/${provider}/status`, {}).then(value => {
    if (statusRevision.get(provider) === revision) applyStatus(provider, value, rejectedAtStart);
  }).finally(() => { manualInflight.delete(provider); });
  manualInflight.set(provider, request);
  return request;
}
// 初回は両方、警告スコープへの移動時は選択先だけ更新し、同時取得は共有する。
export async function loadModels(force = false, provider?: Provider): Promise<void> {
  const targets = provider ? [provider] : providers;
  const result = await Promise.allSettled(targets.map(target => loadProvider(target, force)));
  if (result.every(item => item.status === 'rejected')) throw new Error('接続状態を確認できませんでした');
}
export function resetModelCache() {
  selections.clear(); setStatuses({}); attempted.clear(); inflight.clear(); manualInflight.clear(); statusRevision.clear(); setRevision(value => value + 1);
}
