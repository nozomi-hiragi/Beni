import { createMemo, createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api, ApiError } from '../api';
import { communication } from '../communication';
import { ChatSync } from '../chat-sync';
import { followChatBottom } from '../chat-scroll';
import type { Pack, TaskPhase } from '../../shared/communication';
import { isTaskPhase } from '../../shared/task-phase';
import { findChatCommand, parseChatCommand, type ChatCommand, type ChatCommandDefinition } from '../../shared/chat-commands';
import { availableModels, chooseModel, loadModels, modelIsAvailable, modelLabel, modelScope, modelStatus, modelValue, providerCommands, providerName, providerReady, providerSupportsCompaction, registeredAgents, rejectModel, selectedModel } from '../model-cache';
import type { ChatMessage, Conversation, Model } from '../types';
import { popupHeight } from './chat-popup';
import ModelPicker from './ModelPicker';
import AgentIcon from './icons/AgentIcon';
import ContextGauge from './ContextGauge';

interface Draft { text: string; version: number; sending: boolean; commandSending?: boolean; commandName?: ChatCommand['name']; error: string; listeners: Set<() => void>; refresh?: () => void; pending?: {content: string; fromComposer: boolean; sendId?: string}; restored: Set<string> }
const drafts = new Map<string, Draft>();
const draftFor = (key: string) => {
  let draft = drafts.get(key);
  if (!draft) { draft = { text: '', version: 0, sending: false, error: '', listeners: new Set(), restored: new Set() }; drafts.set(key, draft); }
  return draft;
};
const restoreDraft = (draft: Draft, content: string) => {
  if (!draft.text.startsWith(content)) draft.text = draft.text ? `${content}\n${draft.text}` : content;
};
const commandLabels: Partial<Record<ChatCommand['name'], string>> = {compact:'圧縮',clear:'会話リセット',context:'コンテキスト',usage:'使用量'};
const commandLabel = (name: ChatCommand['name']) => Object.hasOwn(commandLabels, name) ? commandLabels[name] : `/${name}`;
const commandCategories = [
  {kind: 'operation', label: '会話操作'},
  {kind: 'message', label: '生成'},
] as const;
const stateLabel: Record<ChatMessage['status'], string> = { pending: '送信待ち', streaming: '応答中', completed: '完了', failed: '失敗', interrupted: '中断', unknown: '結果不明' };

const chatDateFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function chatDate(value: string) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? chatDateFormatter.format(date) : undefined;
}

function packFooter(pack: Pack) {
  if (pack.role !== 'assistant' || pack.status !== 'completed' || !pack.closedAt) return stateLabel[pack.status];
  const milliseconds = Date.parse(pack.closedAt) - Date.parse(pack.createdAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return stateLabel[pack.status];
  const tenths = Math.round(milliseconds / 100);
  if (tenths < 600) return `${tenths / 10}秒`;
  const seconds = Math.round(milliseconds / 1000);
  const remainder = seconds % 60;
  return `${Math.floor(seconds / 60)}分${remainder ? `${remainder}秒` : ''}`;
}

export type ChatTabStatus = { disabled: boolean; open: () => void };

export default function ChatPanel(props: { projectId: string; taskId?: string; phase?: TaskPhase; readOnly?: boolean; instructionFocus?: string | null; onModelUnavailable?: (model: string, provider?: Model['provider']) => void; onBusyChange?: (busy: boolean) => void; onModelChange?: (model: Model | null) => void; onTabStatusChange?: (taskId: string | undefined, status: ChatTabStatus, failed?: boolean) => void }) {
  const key = () => modelScope(props.projectId, props.taskId, props.phase);
  const [conversationState, setConversationState] = createStore<{scope?: string; value?: Conversation}>({});
  const conversation = () => conversationState.scope === key() ? conversationState.value : undefined;
  const setConversation = (value: Conversation) => setConversationState('value', reconcile(value, {key:'id'}));
  const [packState, setPackState] = createStore<{value: Pack[]}>({value: []});
  const [syncError, setSyncError] = createSignal('');
  const models = createMemo(availableModels);
  const [text, setText] = createSignal('');
  const [commandSending, setCommandSending] = createSignal(false);
  const [pendingCommandName, setPendingCommandName] = createSignal<ChatCommand['name']>('compact');
  const [dismissedCommandIds, setDismissedCommandIds] = createSignal<ReadonlySet<string>>(new Set());
  const statusTitleId = createUniqueId();
  let statusDialog: HTMLDialogElement | undefined;
  let visibleConversationId: string | undefined;
  createEffect(() => {
    const id = conversation()?.id;
    if (id !== visibleConversationId) {
      closeStatus();
      setDismissedCommandIds(new Set<string>());
      visibleConversationId = id;
    }
  });
  const [connected, setConnected] = createSignal(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = createSignal(false);
  const [commandInputFocused, setCommandInputFocused] = createSignal(false);
  const [activeSuggestion, setActiveSuggestion] = createSignal(-1);
  const [suggestionHeight, setSuggestionHeight] = createSignal(256);
  const [commandMenuOpen, setCommandMenuOpen] = createSignal(false);
  const [commandMenuHeight, setCommandMenuHeight] = createSignal(320);
  const commandListId = createUniqueId();
  const commandMenuId = createUniqueId();
  let textarea: HTMLTextAreaElement | undefined;
  let commandDropdown: HTMLDivElement | undefined;
  let commandMenuTrigger: HTMLButtonElement | undefined;
  let composerActions!: HTMLDivElement;
  const commandInput = () => parseChatCommand(text());
  function updateText(value: string) {
    const draft = draftFor(key()); draft.text = value; draft.version++; setText(value);
    setSuggestionsDismissed(false); setActiveSuggestion(-1);
  }
  function acceptSuggestion(index = 0) {
    const item = suggestions()[index];
    if (!item) return;
    updateText(item.command); textarea?.focus(); setSuggestionsDismissed(true);
  }
  function composerKeyDown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (suggestions().length) {
      if (event.key === 'Escape') { event.preventDefault(); setSuggestionsDismissed(true); setActiveSuggestion(-1); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); setActiveSuggestion(index => event.key === 'ArrowDown' ? (index + 1) % suggestions().length : (index <= 0 ? suggestions().length - 1 : index - 1));
        return;
      }
      if (!event.shiftKey && (event.key === 'Tab' || event.key === 'Enter' && activeSuggestion() >= 0)) {
        event.preventDefault(); acceptSuggestion(Math.max(0, activeSuggestion())); return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    if (!event.repeat && !submitDisabled()) void send();
  }
  const selection = () => selectedModel(key());
  const modelAvailable = () => modelIsAvailable(key());
  const selectedProvider = () => selection() ? selection()!.provider ?? 'codex' : undefined;
  const connectionId = () => selectedProvider() ?? registeredAgents()[0]?.id;
  const connectionNotice = () => {
    const provider = connectionId();
    if (!provider) return;
    const status = modelStatus(provider), name = providerName(provider);
    if (status?.availability === 'not-installed') return `${name}${provider === 'codex' || provider === 'claude' ? ' CLI' : ''} をインストールしてください。`;
    if (status?.availability === 'unsupported-version') return `${name} を対応バージョンに更新してください。`;
    if (status?.availability !== 'unavailable') return;
    if (status.auth === 'none') return `${name} にログインしてください。`;
    if ((provider === 'codex' || provider === 'claude') && (status.auth === 'api-key' || status.auth === 'other')) return `${name} はサブスクリプション以外の認証方式です。設定を確認してください。`;
    return `${name} の接続状態を設定で確認してください。`;
  };
  const commandFor = (name: string, provider = selectedProvider()) => findChatCommand(name, provider, providerCommands(provider));
  const permittedCommands = () => providerCommands(modelAvailable() ? selectedProvider() : undefined)
    .filter(item => item.name !== 'compact' && (item.kind !== 'message' || props.projectId !== 'instructions'));
  createEffect(() => { selectedProvider(); setActiveSuggestion(-1); });
  createEffect(() => props.onModelChange?.(modelAvailable() ? selection()! : null));
  function selectModel(value: string) {
    const available = models().find(item => modelValue(item) === value);
    if (available && providerReady(available.provider)) chooseModel(key(), available);
  }
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loadError, setLoadError] = createSignal('');
  const [interrupting, setInterrupting] = createSignal(false);
  const query = () => `/api/chat?projectId=${props.projectId}${props.taskId === undefined ? '' : `&taskId=${props.taskId}&phase=${props.phase}`}`;
  let scrollport!: HTMLDivElement, scrollContent!: HTMLDivElement;
  let bottomFollow: ReturnType<typeof followChatBottom> | undefined;
  const sizeSuggestions = () => {
    if (textarea) setSuggestionHeight(Math.max(40, popupHeight(textarea, 256)));
  };
  onMount(() => {
    bottomFollow = followChatBottom(scrollport, scrollContent);
    window.addEventListener('resize',sizeSuggestions);
    onCleanup(() => { bottomFollow?.dispose(); window.removeEventListener('resize',sizeSuggestions); });
  });
  createEffect(() => { key(); bottomFollow?.reset(); });
  let refresh: () => void = () => {};
  createEffect(() => {
    const currentKey = key(), url = query(), draft = draftFor(currentKey);
    const controller = new AbortController();
    let modelRefreshRequested = !untrack(() => selectedModel(currentKey)) || untrack(() => !modelIsAvailable(currentKey));
    const hadModels = untrack(() => registeredAgents().some(agent => modelStatus(agent.id)));
    let active = true, sequence = 0,fetching=false,reload=false;
    const sync = new ChatSync({ projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }) }, packs => { if (active) setPackState('value', reconcile(packs, {key: 'packId'})); }, message => { if (active) setSyncError(message); });
    const updateDraft = () => { setText(draft.text); setSending(draft.sending); setCommandSending(!!draft.commandSending); setPendingCommandName(draft.commandName ?? 'compact'); setError(draft.error); };
    draft.listeners.add(updateDraft);
    setConversationState({scope: currentKey, value: undefined});
    closeStatus(); setConnected(false); setSuggestionsDismissed(false); setActiveSuggestion(-1); setCommandMenuOpen(false); updateDraft(); setLoadError(''); setSyncError(''); setInterrupting(false);
    const load = async () => {
      if(fetching){reload=true;return}fetching=true;
      do {reload=false;
      const request = ++sequence;
      try {
        const value = await api<Conversation>(url, undefined, controller.signal);
        if (active && request === sequence) {
          if (!untrack(() => selectedModel(currentKey)) && value.selectedModel) {
            chooseModel(currentKey, value.selectedModel);
            if (hadModels && !untrack(() => modelIsAvailable(currentKey)) && modelRefreshRequested) {
              modelRefreshRequested = false;
              void loadModels(true, value.selectedModel.provider ?? 'codex').catch(() => {});
            }
          }
          const previous = conversation();
          const latest = value.messages.findLast(message => message.role === 'assistant');
          if (previous && latest && latest.status !== 'pending' && latest.status !== 'streaming') {
            const last = previous.messages.findLast(message => message.role === 'assistant');
            if (last?.id !== latest.id || last?.status !== latest.status) void loadModels(true, latest.provider).catch(() => {});
          }
          sync.conversation(value.id);
          setConversation(value);
          setLoadError('');
        }
      }
      catch { if (active && request === sequence) setLoadError('履歴を取得できませんでした'); }
      }while(reload&&active);fetching=false;
    };
    const refreshCurrent = () => { void load(); sync.refresh(); };
    refresh = refreshCurrent; draft.refresh = refreshCurrent;
    void load(); sync.refresh();
    void loadModels(false).catch(() => {});
    if (untrack(() => !!selectedModel(currentKey) && !modelIsAvailable(currentKey))) void loadModels(true, untrack(() => selectedModel(currentKey)?.provider)).catch(() => {});
    const unsubscribe = communication.subscribe('chat', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }) }, {
      subscribed: () => { if (active) { setConnected(true); setSyncError(''); sync.subscribed(); void load(); } },
      event: event => { if (active) { sync.event(event); if (event.name === 'chat.changed') void load(); } },
      error: message => { if (active) { setConnected(false); setSyncError(message); } },
    });
    onCleanup(() => { active = false; sequence++; controller.abort(); unsubscribe(); sync.dispose(); draft.listeners.delete(updateDraft); if (draft.refresh === refreshCurrent) draft.refresh = undefined; });
  });
  createEffect(() => {
    const value = conversation(), available = models().find(item => providerReady(item.provider)), scope = key();
    if (value && !selectedModel(scope) && available) chooseModel(scope, available);
    const rejected = value?.messages.filter(message => message.errorCode === 'MODEL_UNAVAILABLE') ?? [];
    const draft = draftFor(scope);
    for (const message of rejected) {
      if (message.model) props.onModelUnavailable?.(message.model, message.provider);
      if (!draft.pending?.sendId || draft.pending.sendId !== message.sendId || draft.restored.has(message.sendId)) continue;
      draft.restored.add(message.sendId);
      if (message.model) rejectModel(scope, message.model, message.provider);
      const content = value?.messages.find(item => item.sendId === message.sendId && item.role === 'user')?.content;
      if (content && draft.pending?.content === content) {
        if (draft.pending.fromComposer) restoreDraft(draft, content);
        draft.pending = undefined;
        draft.error = '選択したモデルを利用できません。別のモデルを選択してください。';
        draft.listeners.forEach(listener => listener());
      }
    }
  });
  const latestOutcome = () => {
    const message = conversation()?.messages.findLast(message => message.role === 'assistant');
    return message && (message.status === 'failed' || message.status === 'interrupted' || message.status === 'unknown') ? stateLabel[message.status] : undefined;
  };
  const compacting = () => commandSending() || conversation()?.command?.status === 'running';
  const runningCommandName = () => commandSending() ? pendingCommandName() : conversation()?.command?.name ?? 'compact';
  const commandProgress = () => runningCommandName() === 'compact' ? '圧縮中' : `${commandLabel(runningCommandName())}中`;
  const commandOutcome = () => {
    const command = conversation()?.command;
    return command && command.status !== 'running' ? `${commandLabel(command.name)}: ${{completed: '完了', failed: '失敗', interrupted: '中断', unknown: '結果不明'}[command.status]}${command.error ? ` · ${command.error}` : ''}` : '';
  };
  const visibleCommandId = () => commandOutcome() && !dismissedCommandIds().has(conversation()!.command!.id) ? conversation()!.command!.id : undefined;
  const dismissCommand = (id: string) => setDismissedCommandIds(previous => new Set([...previous,id]));
  const busy = () => sending() || compacting() || !!conversation()?.messages.some(message => message.status === 'pending' || message.status === 'streaming');
  const selectedSessionKey = () => selection() ? `${selectedProvider()}/${selection()!.id}` : undefined;
  const contextSession = () => {
    const value = conversation(), selected = selection(), provider = selectedProvider(), sessionKey = selectedSessionKey();
    if (!value || !selected || !provider || !sessionKey) return undefined;
    if (value.sessionProvider === provider && value.selectedModel?.id === selected.id && (value.selectedModel.provider ?? 'codex') === provider && value.threadId) return value;
    return value.sessions?.[sessionKey];
  };
  const contextUsage = () => contextSession()?.contextUsage;
  const canCompact = () => {
    const session = contextSession(), provider = selectedProvider();
    return !!session?.threadId && !props.readOnly && !busy() && modelAvailable() && providerSupportsCompaction(provider);
  };
  const commandMenuDisabled = () => props.readOnly || busy() || !conversation() || !!loadError() || !permittedCommands().length;

  createEffect(() => {
    const report = props.onTabStatusChange;
    if (!report) return;
    const taskId = props.taskId, scope = key();
    const disabled = !conversation();
    const failed = disabled && !!loadError();
    let active = true;
    const status = {
      disabled,
      open: () => {
        if (active && !disabled && scope === key()) openStatus();
      },
    };
    onCleanup(() => { active = false; });
    untrack(() => report(taskId, status, failed));
  });
  createEffect(() => {
    if (commandMenuDisabled()) setCommandMenuOpen(false);
  });
  createEffect(() => {
    if (!commandMenuOpen() || !commandDropdown) return;
    const size = () => { if (commandDropdown) setCommandMenuHeight(popupHeight(commandDropdown, 320)); };
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !commandDropdown?.contains(event.target)) setCommandMenuOpen(false);
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : undefined;
    observer?.observe(scrollport);
    observer?.observe(commandDropdown);
    size();
    window.addEventListener('resize', size);
    document.addEventListener('pointerdown', dismiss, true);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener('resize', size);
      document.removeEventListener('pointerdown', dismiss, true);
    });
  });
  function runMenuCommand(definition: ChatCommandDefinition) {
    if (commandMenuDisabled()) return;
    setCommandMenuOpen(false);
    commandMenuTrigger?.focus();
    void send(definition.command);
  }
  async function executeOperation(name: string, args = '', clearDraft = false) {
    const currentKey = key(), draft = draftFor(currentKey), sentModel = selection(), version = draft.version;
    if (props.readOnly || draft.sending || busy() || !conversation() || loadError() || !sentModel || !modelAvailable()) return;
    if (name === 'clear' && !window.confirm('現在の会話をリセットしますか？履歴はアーカイブに残ります。')) return;
    draft.sending = true; draft.commandSending = true; draft.commandName = name; draft.error = ''; draft.listeners.forEach(listener => listener());
    try {
      const accepted = await api<{command: ChatCommand}>('/api/chat/commands', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : {phase: props.phase}), command: name, args, provider: sentModel.provider ?? 'codex', model: sentModel.id });
      if (clearDraft && draft.version === version) draft.text = '';
      if (name === 'clear') draft.pending = undefined;
      if (key() === currentKey && conversation()) setConversation({...conversation()!, command: accepted.command});
      draft.refresh?.();
    } catch (error) {
      draft.error = error instanceof ApiError && error.status >= 400 && error.status < 500 ? `${commandLabel(name)}できませんでした: ${error.message}` : `${commandLabel(name)}を確認できませんでした。状態を確認してください。`;
      draft.refresh?.();
    } finally { draft.sending = false; draft.commandSending = false; draft.listeners.forEach(listener => listener()); }
  }
  function compactSelectedSession() {
    if (!canCompact()) return;
    void executeOperation('compact');
  }
  const suggestions = createMemo(() => {
    const prefix = text().trimStart();
    return commandInputFocused() && !suggestionsDismissed() && !props.readOnly && !busy() && /^\/[A-Za-z0-9_-]*$/.test(prefix)
      ? permittedCommands().filter(item => item.command.startsWith(prefix) || item.aliases?.some(alias => `/${alias}`.startsWith(prefix))) : [];
  });
  createEffect(() => {
    const index = activeSuggestion(), count = suggestions().length;
    if (count && textarea && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(sizeSuggestions);
      observer.observe(scrollport); observer.observe(textarea);
      onCleanup(() => observer.disconnect());
    }
    queueMicrotask(() => {
      if (count) sizeSuggestions();
      if (index >= 0 && count) document.getElementById(`${commandListId}-${index}`)?.scrollIntoView?.({block:'nearest'});
    });
  });
  createEffect(() => props.onBusyChange?.(busy()));
  const validInstructionFocus = () => props.projectId !== 'instructions' || props.instructionFocus === 'common' || props.instructionFocus === 'editor' || isTaskPhase(props.instructionFocus);
  function openStatus() {
    if (conversation() && statusDialog && !statusDialog.open) statusDialog.showModal();
  }
  function closeStatus() {
    if (statusDialog?.open) statusDialog.close();
  }
  const submitBlocked = () => {
    const parsed = commandInput();
    if (!parsed) return !validInstructionFocus() || !modelAvailable();
    if (parsed.name === 'compact') return true;
    const definition = commandFor(parsed.name) ?? (!selection() ? registeredAgents().map(agent => commandFor(parsed.name, agent.id)).find(Boolean) : undefined);
    return definition?.kind === 'operation' ? !modelAvailable() : definition?.kind === 'message' ? props.projectId === 'instructions' || !validInstructionFocus() || !modelAvailable() : false;
  };
  const submitDisabled = () => submitBlocked() || busy() || !text().trim() || !conversation() || !!loadError();
  async function send(explicitContent?: string) {
    const currentKey = key(), draft = draftFor(currentKey), content = explicitContent ?? draft.text, version = draft.version, sentModel = selection(), sentInstructionFocus = props.instructionFocus;
    const fromComposer = explicitContent === undefined;
    const clearSubmittedText = () => { if (fromComposer && draft.version === version) draft.text = ''; };
    if (props.readOnly || draft.sending || busy() || !conversation() || loadError() || !content.trim()) return;
    const command = parseChatCommand(content);
    if (command) {
      if (command.name === 'compact') { draft.error = '不明なコマンドです。'; draft.listeners.forEach(listener => listener()); return; }
      const definition = commandFor(command.name);
      if (!definition || definition.kind === 'message' && props.projectId === 'instructions') {
        draft.error = '不明なコマンドです。'; draft.listeners.forEach(listener => listener()); return;
      }
      if (definition.kind === 'operation') {
        if (command.args && !definition.argumentHint) { draft.error = `${definition.command} に引数は指定できません。`; draft.listeners.forEach(listener => listener()); return; }
        if (!sentModel || !modelAvailable()) return;
        await executeOperation(definition.name, command.args, fromComposer);
        return;
      }
    }
    if (!validInstructionFocus() || !modelAvailable()) return;
    draft.sending = true; draft.error = ''; draft.listeners.forEach(listener => listener());
    try {
      draft.pending = {content, fromComposer};
      const accepted = await api<Conversation>('/api/chat/send', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }), ...(props.projectId === 'instructions' ? {instructionFocus: sentInstructionFocus} : {}), content, model: sentModel!.id, provider: sentModel!.provider ?? 'codex' });
      if (draft.pending) { draft.pending.sendId = accepted.messages?.findLast(message => message.role === 'user')?.sendId; clearSubmittedText(); }
      draft.listeners.forEach(listener => listener());
      draft.refresh?.();
    } catch (error) {
      draft.pending = undefined;
      if (error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE') { rejectModel(currentKey, sentModel!.id, sentModel!.provider); if (fromComposer) restoreDraft(draft, content); }
      draft.error = error instanceof ApiError && error.status >= 400 && error.status < 500 ? `送信できませんでした: ${error.message}` : '送信を確認できませんでした。履歴を確認してから再送してください。';
      draft.listeners.forEach(listener => listener());
      draft.refresh?.();
    } finally {
      draft.sending = false;
      draft.listeners.forEach(listener => listener());
    }
  }
  async function interrupt() {
    const currentKey = key(); setInterrupting(true); setError('');
    try { await api('/api/chat/interrupt', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }) }); }
    catch { if (key() === currentKey) setError('中断を確認できませんでした。状態を確認してください。'); }
    finally { if (key() === currentKey) { setInterrupting(false); refresh(); } }
  }
  return <>
    <Show when={connectionNotice()}>{notice => <p class="px-4 pt-3 text-sm">{notice()}</p>}</Show>
    <Show when={loadError()}><p role="alert" class="px-4 pt-3 text-sm text-error">{loadError()}</p></Show>
    <Show when={syncError()}><p role="alert" class="px-4 pt-3 text-sm text-error">{syncError()} <button class="btn btn-xs" onClick={() => refresh()}>更新</button></p></Show>
    <div ref={scrollport} class="min-h-0 flex-1 overflow-y-auto p-5" role="log" aria-label="チャット履歴" aria-live="polite">
      <div ref={scrollContent} class="space-y-3">
        <Show when={packState.value.length} fallback={<p class="text-sm text-base-content/50">希望や回答を入力してください。</p>}><For each={packState.value}>{pack => <article class={`chat ${pack.role === 'user' ? 'chat-end' : 'chat-start'}`}>
        <Show when={pack.role === 'assistant'}>
          <div class="chat-image avatar">
            <div class="grid size-8 place-items-center rounded-full bg-base-200">
              <AgentIcon provider={pack.provider} />
            </div>
          </div>
        </Show>
        <div class="chat-header items-center text-xs text-base-content/60">
          <span>
            {pack.model ? modelLabel(pack.model, pack.provider) : providerName(pack.provider)}
            <Show when={chatDate(pack.createdAt)}>{date => <>{' '}<time dateTime={pack.createdAt}>{date()}</time></>}</Show>
          </span>
        </div><div class={`chat-bubble min-w-0 ${pack.role === 'user' ? 'chat-bubble-primary' : 'bg-base-200 text-base-content'}`}><Show when={pack.kind === 'tool'} fallback={<p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{pack.content}</p>}><details><summary>{pack.tool?.name ?? 'ツール'}</summary><pre class="whitespace-pre-wrap break-words text-xs">{pack.tool?.input}</pre><pre class="whitespace-pre-wrap break-words text-xs">{pack.tool?.output}</pre></details></Show></div><div class="chat-footer text-xs text-base-content/60">{packFooter(pack)}</div></article>}</For></Show>
        <Show when={visibleCommandId()} keyed>{id => <div class="flex min-w-0 items-start gap-2 rounded-box border border-base-300 px-3 py-2 text-sm">
          <Show when={conversation()?.command?.output} fallback={<p role="status" class="min-w-0 flex-1">{commandOutcome()}</p>}>
            <details class="min-w-0 flex-1"><summary class="cursor-pointer truncate">{commandOutcome()}</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{conversation()?.command?.output}</pre></details>
          </Show>
          <button type="button" class="btn btn-ghost btn-xs shrink-0" aria-label="コマンド結果を閉じる" onClick={() => dismissCommand(id)}><span aria-hidden="true">×</span></button>
        </div>}</Show>
      </div>
    </div>
    <Show when={busy()}><div role="status" class="mx-4 mb-3 self-start"><div class="aura text-primary motion-reduce:animate-none"><div class="card bg-base-100 px-4 py-2 text-sm text-base-content">{compacting() ? `${commandProgress()}…` : '作業中…'}</div></div></div></Show>
    <Show when={latestOutcome()}><p role="status" class="mx-4 mb-2 text-sm">直近の応答: {latestOutcome()}</p></Show>
    <Show when={error()}><p role="alert" class="mx-4 mb-2 text-sm text-error">{error()}</p></Show>
    <Show when={!props.readOnly}><form class="border-t border-base-300 p-4" onSubmit={event => { event.preventDefault(); void send(); }}>
      <div class="relative">
        <textarea ref={textarea} class="textarea textarea-bordered block min-h-24 w-full resize-y" aria-label="希望や回答を入力" placeholder="希望や回答を入力" aria-autocomplete="list" aria-controls={suggestions().length ? commandListId : undefined} aria-expanded={!!suggestions().length} aria-activedescendant={suggestions().length && activeSuggestion() >= 0 ? `${commandListId}-${activeSuggestion()}` : undefined} required value={text()} onInput={event => { setCommandInputFocused(true); updateText(event.currentTarget.value); }} onKeyDown={composerKeyDown} onFocus={() => { setCommandInputFocused(true); setSuggestionsDismissed(false); }} onBlur={() => setCommandInputFocused(false)} />
        <Show when={suggestions().length}><ul id={commandListId} role="listbox" aria-label="スラッシュコマンド" style={{'max-height':`${suggestionHeight()}px`}} class="absolute bottom-full left-0 z-50 mb-2 w-72 max-w-full overflow-y-auto overscroll-contain rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"><For each={suggestions()}>{(item, index) => <li role="none"><button id={`${commandListId}-${index()}`} role="option" aria-selected={activeSuggestion() === index()} type="button" class={`w-full rounded px-3 py-2 text-left text-sm hover:bg-base-200 ${activeSuggestion() === index() ? 'bg-base-200' : ''}`} onMouseDown={event => event.preventDefault()} onClick={() => acceptSuggestion(index())}>{item.command} · {item.description}</button></li>}</For></ul></Show>
      </div>
      <div ref={composerActions} class="@container relative mt-2 flex flex-wrap items-center justify-between gap-2">
        <div ref={commandDropdown} class="dropdown dropdown-top dropdown-start"
          classList={{'dropdown-open': commandMenuOpen()}}
          onFocusOut={event => {
            if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setCommandMenuOpen(false);
          }}
          onKeyDown={event => {
            if (event.key === 'Escape' && commandMenuOpen()) {
              event.preventDefault(); event.stopPropagation(); setCommandMenuOpen(false); commandMenuTrigger?.focus();
            }
          }}>
          <button ref={commandMenuTrigger} type="button" class="btn btn-sm" disabled={commandMenuDisabled()}
            aria-expanded={commandMenuOpen()} aria-controls={commandMenuOpen() ? commandMenuId : undefined}
            onClick={event => { event.currentTarget.focus(); setCommandMenuOpen(open => !open); }}>コマンド</button>
          <Show when={commandMenuOpen()}>
            <ul id={commandMenuId} aria-label="チャットコマンド" style={{'max-height': `${commandMenuHeight()}px`}}
              class="dropdown-content menu menu-sm mb-2 w-[min(20rem,100cqw)] flex-nowrap overflow-y-auto overscroll-contain rounded-box border border-base-300 bg-base-100 shadow-lg">
              <For each={commandCategories}>{category => {
                const commands = createMemo(() => permittedCommands().filter(command => command.kind === category.kind));
                return <Show when={commands().length}><li><details>
                  <summary>{category.label}</summary>
                  <ul><For each={commands()}>{command => <li>
                    <button type="button" class="min-w-0" onClick={() => runMenuCommand(command)}>
                      <span class="min-w-0 whitespace-normal wrap-anywhere">{command.command} · {command.description}</span>
                    </button>
                  </li>}</For></ul>
                </details></li></Show>;
              }}</For>
            </ul>
          </Show>
        </div>
        <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Show when={key()} keyed>
            <ContextGauge usage={contextUsage()} compactAvailable={canCompact()} onCompact={compactSelectedSession} />
            <ModelPicker models={models()} selection={selection()} available={modelAvailable()} busy={busy()} anchor={() => composerActions} onSelect={selectModel} />
          </Show>
          <Show when={busy()}><button type="button" class="btn btn-sm" disabled={interrupting()} onClick={interrupt}>中断</button></Show>
          <button class="btn btn-primary btn-sm" type="submit" disabled={submitDisabled()}>{busy() ? (compacting() ? `${commandProgress()}...` : '応答中...') : '送信'}</button>
        </div>
      </div>
    </form></Show>
    <Show when={props.onTabStatusChange}>
      <dialog ref={statusDialog} class="modal" aria-labelledby={statusTitleId}>
        <div class="modal-box">
          <h2 id={statusTitleId} class="text-lg font-bold">チャットの状態</h2>
          <Show when={conversation()}>{value => <dl class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt>選択</dt><dd class="wrap-anywhere">{selection() ? modelLabel(selection()!.id, selectedProvider()) : '未選択'}</dd>
            <dt>保存された接続先</dt><dd class="wrap-anywhere">{value().sessionProvider ? providerName(value().sessionProvider) : '未開始'}</dd>
            <dt>メッセージ数</dt><dd>{value().messages.length}</dd>
            <dt>モデル接続</dt><dd>{selection() && providerReady(selectedProvider()) ? '利用可能' : '利用不可'}</dd>
            <dt>更新接続</dt><dd>{connected() ? '接続済み' : '未接続'}</dd>
          </dl>}</Show>
          <div class="modal-action"><button type="button" class="btn" onClick={closeStatus}>閉じる</button></div>
        </div>
      </dialog>
    </Show>
  </>;
}
