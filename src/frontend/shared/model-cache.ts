import { createSignal, untrack } from 'solid-js';
import { api, ApiError } from './api';
import { isAgentId, type AgentConnectionStatus, type AgentInfo } from '../../shared/agent';
import { beniChatCommands, type ChatCommandDefinition } from '../../shared/chat-commands';
import type { ClaudeStatus, CodexStatus, Model, Provider } from './types';

type Selection = Model & { rejected?: boolean };
type Status = AgentConnectionStatus;
type Registry = { agents: readonly AgentInfo[]; legacy: boolean };
const [registry, setRegistry] = createSignal<Registry>();
let registryInflight: Promise<Registry> | undefined;
const [statuses, setStatuses] = createSignal<Partial<Record<Provider, Status>>>({});
const [revision, setRevision] = createSignal(0);
const attempted = new Set<Provider>();
const inflight = new Map<Provider, Promise<void>>();
const manualInflight = new Map<Provider, Promise<void>>();
const statusRevision = new Map<Provider, number>();
const selections = new Map<string, Selection>();
const legacyAgents: readonly AgentInfo[] = [
  {id:'codex', name:'Codex', commands:[], supportsUsage:true, supportsContextUsage:true},
  {id:'claude', name:'Claude', commands:[], supportsUsage:true, supportsContextUsage:true},
];
export const registeredAgents = () => registry()?.agents ?? [];
export const registeredAgent = (provider: Provider) => registeredAgents().find(agent => agent.id === provider);
export function loadAgentRegistry(): Promise<Registry> {
  const current = untrack(registry);
  if (current) return Promise.resolve(current);
  if (registryInflight) return registryInflight;
  const request = api<{ agents: readonly AgentInfo[] }>('/api/agents').then(({agents}) => {
    if (!Array.isArray(agents) || agents.some(agent => !isAgentId(agent?.id) || typeof agent.name !== 'string' || !Array.isArray(agent.commands) || typeof agent.supportsUsage !== 'boolean')) {
      throw new Error('エージェントの登録情報を確認できませんでした');
    }
    return { agents, legacy: false };
  }).catch(error => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return { agents: legacyAgents, legacy: true };
    throw error;
  }).then(value => {
    if (registryInflight === request) setRegistry(value);
    return value;
  }).finally(() => {
    if (registryInflight === request) registryInflight = undefined;
  });
  registryInflight = request;
  return request;
}
export const modelScope = (projectId: string, taskId?: string, phase?: string) => `${projectId}:${taskId ?? 'general'}:${phase ?? ''}`;
export const providerName = (provider: Provider = 'codex') => registeredAgent(provider)?.name ?? legacyAgents.find(agent => agent.id === provider)?.name ?? provider;
export const modelLabel = (name: string, provider: Provider = 'codex') => `${providerName(provider)}/${name}`;
export const modelValue = (model: Model) => `${model.provider ?? 'codex'}:${model.id}`;
export const modelStatus = (provider: Provider) => Object.hasOwn(statuses(), provider) ? statuses()[provider] : undefined;
export const providerReady = (provider: Provider = 'codex') => !!registeredAgent(provider) && modelStatus(provider)?.availability === 'ready';
export const availableModels = (): Model[] => registeredAgents().flatMap(({id: provider}) => modelStatus(provider)?.models?.map(model => ({...model, provider})) ?? []);
export function providerCommands(provider?: Provider): readonly ChatCommandDefinition[] {
  const agent = provider === undefined ? undefined : registeredAgent(provider);
  if (!agent) return [];
  const commands: ChatCommandDefinition[] = agent.commands.filter(command => command.name !== 'compact').map(command => ({
    ...command,
    command: `/${command.name}`,
    kind: command.kind === 'generation' ? 'message' : 'operation',
  }));
  return [...beniChatCommands, ...commands];
}
export function providerSupportsCompaction(provider: Provider | undefined): boolean {
  if (!provider) return false;
  return registeredAgent(provider)?.commands.some(command => command.kind === 'maintenance' && command.name === 'compact') ?? false;
}
export function selectedModel(scope: string): Selection | undefined {
  revision();
  if (!selections.has(scope)) {
    try {
      const value = JSON.parse(localStorage.getItem(`beni:model:${scope}`) ?? 'null');
      if (value && typeof value.id === 'string' && value.id && typeof value.name === 'string' && (value.provider === undefined || isAgentId(value.provider))) selections.set(scope, {...value, provider: value.provider ?? 'codex'});
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
  const provider = selected?.provider ?? 'codex';
  return !!selected && !selected.rejected && providerReady(provider) && !!modelStatus(provider)?.models?.some(model => model.id === selected.id);
}
function fromLegacyStatus(provider: Provider, status: CodexStatus | ClaudeStatus): Status {
  const version = status.version ?? undefined;
  const versionParts = version?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const [major, minor, patch] = versionParts ?? [];
  const unsupported = provider === 'claude' && !!version && (!versionParts || major < 2 || major === 2 && (minor < 1 || minor === 1 && patch < 292));
  const subscription = status.auth === (provider === 'claude' ? 'claude' : 'chatgpt');
  return {
    availability: !status.installed ? 'not-installed' : unsupported ? 'unsupported-version' : subscription ? 'ready' : 'unavailable',
    auth: subscription ? 'subscription' : status.auth === 'apiKey' ? 'api-key' : status.auth === 'none' || status.auth === 'other' ? status.auth : 'unknown',
    executablePath: status.path ?? undefined,
    version,
    checkedAt: status.checkedAt,
    models: status.models ?? null,
    usage: status.usage ?? 'unknown',
  };
}
function requestStatus(provider: Provider, legacy: boolean, manual = false): Promise<Status> {
  const body = manual ? {} : undefined;
  return legacy
    ? api<CodexStatus | ClaudeStatus>(`/api/${provider}/status`, body).then(value => fromLegacyStatus(provider, value))
    : api<Status>(`/api/agents/${provider}/status`, body);
}
function loadProvider(provider: Provider, legacy: boolean, force: boolean): Promise<void> {
  const manualPending = manualInflight.get(provider);
  if (manualPending) return manualPending;
  const pending = inflight.get(provider);
  if (pending) return pending;
  if (attempted.has(provider) && !force) return Promise.resolve();
  attempted.add(provider);
  const revision = (statusRevision.get(provider) ?? 0) + 1;
  statusRevision.set(provider, revision);
  const rejectedAtStart = new Map([...selections].filter(([, selected]) => selected.rejected && (selected.provider ?? 'codex') === provider));
  const request = requestStatus(provider, legacy).then(value => {
    if (statusRevision.get(provider) === revision) applyStatus(provider, value, rejectedAtStart);
  }).finally(() => { inflight.delete(provider); });
  inflight.set(provider, request);
  return request;
}
function applyStatus(provider: Provider, value: Status, rejectedAtStart: Map<string, Selection>) {
  setStatuses(previous => ({...previous, [provider]: value}));
  for (const [scope, selected] of rejectedAtStart) {
    if (selections.get(scope) === selected && value.availability === 'ready' && value.models?.some(model => model.id === selected.id)) chooseModel(scope, {id: selected.id, name: selected.name, provider});
  }
}
// 設定画面の明示的な更新。GETの進行中リクエストとは共有せず、POSTの結果を同じ状態キャッシュへ反映する。
export async function refreshProviderStatus(provider: Provider): Promise<void> {
  const {agents, legacy} = await loadAgentRegistry();
  if (!agents.some(agent => agent.id === provider)) throw new Error('エージェントが登録されていません');
  const pending = manualInflight.get(provider);
  if (pending) return pending;
  attempted.add(provider);
  const revision = (statusRevision.get(provider) ?? 0) + 1;
  statusRevision.set(provider, revision);
  const rejectedAtStart = new Map([...selections].filter(([, selected]) => selected.rejected && (selected.provider ?? 'codex') === provider));
  const request = requestStatus(provider, legacy, true).then(value => {
    if (statusRevision.get(provider) === revision) applyStatus(provider, value, rejectedAtStart);
  }).finally(() => { manualInflight.delete(provider); });
  manualInflight.set(provider, request);
  return request;
}
// 初回は登録先すべて、警告スコープへの移動時は選択先だけ更新する。
export async function loadModels(force = false, provider?: Provider): Promise<void> {
  const {agents, legacy} = await loadAgentRegistry();
  const targets = agents.filter(agent => provider === undefined || agent.id === provider);
  const result = await Promise.allSettled(targets.map(({id}) => loadProvider(id, legacy, force)));
  if (result.length && result.every(item => item.status === 'rejected')) throw new Error('接続状態を確認できませんでした');
}
export function resetModelCache() {
  registryInflight = undefined; setRegistry(undefined);
  selections.clear(); setStatuses({}); attempted.clear(); inflight.clear(); manualInflight.clear(); statusRevision.clear(); setRevision(value => value + 1);
}
