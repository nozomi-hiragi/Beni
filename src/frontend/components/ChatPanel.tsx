import { createMemo, createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api, ApiError } from '../api';
import { communication } from '../communication';
import { ChatSync } from '../chat-sync';
import { followChatBottom } from '../chat-scroll';
import type { Pack, TaskPhase } from '../../shared/communication';
import { isTaskPhase } from '../../shared/task-phase';
import { commandsForProvider, findChatCommand, parseChatCommand, type ChatCommand, type ChatCommandDefinition } from '../../shared/chat-commands';
import { availableModels, chooseModel, loadModels, modelIsAvailable, modelLabel, modelScope, modelStatus, modelValue, providerName, providerReady, rejectModel, selectedModel } from '../model-cache';
import type { ChatMessage, Conversation, Model, Task } from '../types';

interface Draft { text: string; version: number; sending: boolean; commandSending?: boolean; commandName?: ChatCommand['name']; error: string; listeners: Set<() => void>; refresh?: () => void; pending?: {content: string; version: number; sendId?: string}; restored: Set<string> }
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
const commandLabel = (name: ChatCommand['name']) => commandLabels[name] ?? `/${name}`;
const stateLabel: Record<ChatMessage['status'], string> = { pending: '送信待ち', streaming: '応答中', completed: '完了', failed: '失敗', interrupted: '中断', unknown: '結果不明' };

export default function ChatPanel(props: { projectId: string; taskId?: string; phase?: TaskPhase; readOnly?: boolean; instructionFocus?: string | null; instructionFocusLabel?: string; onModelUnavailable?: (model: string, provider?: Model['provider']) => void; onBusyChange?: (busy: boolean) => void; onModelChange?: (model: Model | null) => void; onTaskRename?: (task: Task) => void }) {
  const [conversationState,setConversationState]=createStore<{value?:Conversation}>({});
  const conversation=()=>conversationState.value;
  const setConversation=(value:Conversation|undefined)=>setConversationState('value',value===undefined?undefined:reconcile(value,{key:'id'}));
  const [packState, setPackState] = createStore<{value: Pack[]}>({value: []});
  const [syncError, setSyncError] = createSignal('');
  const status = () => modelStatus();
  const models = createMemo(availableModels);
  const [text, setText] = createSignal('');
  const [commandSending, setCommandSending] = createSignal(false);
  const [pendingCommandName, setPendingCommandName] = createSignal<ChatCommand['name']>('compact');
  const [localResult, setLocalResult] = createSignal<{name: string; output: string}>();
  const [dismissedCommandIds, setDismissedCommandIds] = createSignal<ReadonlySet<string>>(new Set());
  let localConversationId: string | undefined;
  createEffect(() => {
    const id = conversation()?.id;
    if (id !== localConversationId) { setLocalResult(undefined); setDismissedCommandIds(new Set<string>()); localConversationId = id; }
  });
  const [connected, setConnected] = createSignal(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = createSignal(false);
  const [commandInputFocused, setCommandInputFocused] = createSignal(false);
  const [activeSuggestion, setActiveSuggestion] = createSignal(-1);
  const [suggestionHeight, setSuggestionHeight] = createSignal(256);
  const commandListId = createUniqueId();
  let textarea: HTMLTextAreaElement | undefined;
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
  function commandKeyDown(event: KeyboardEvent) {
    if (!suggestions().length || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); setSuggestionsDismissed(true); setActiveSuggestion(-1); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setActiveSuggestion(index => event.key === 'ArrowDown' ? (index + 1) % suggestions().length : (index <= 0 ? suggestions().length - 1 : index - 1));
    } else if (event.key === 'Tab' && !event.shiftKey || event.key === 'Enter' && !event.shiftKey && activeSuggestion() >= 0) {
      event.preventDefault(); acceptSuggestion(Math.max(0, activeSuggestion()));
    }
  }
  const key = () => modelScope(props.projectId, props.taskId, props.phase);
  const selection = () => selectedModel(key());
  const model = () => selection() ? modelValue(selection()!) : '';
  const modelAvailable = () => modelIsAvailable(key());
  const selectedProvider = () => selection() ? selection()!.provider ?? 'codex' : undefined;
  const permittedCommands = () => commandsForProvider(modelAvailable() ? selectedProvider() : undefined).filter(item => (item.name !== 'rename' || !!props.taskId) && (item.kind !== 'message' || props.projectId !== 'instructions'));
  createEffect(() => { selectedProvider(); setActiveSuggestion(-1); });
  createEffect(() => props.onModelChange?.(modelAvailable() ? selection()! : null));
  function selectModel(value: string) {
    const available = models().find(item => modelValue(item) === value);
    if (available) chooseModel(key(), available);
  }
  let modelSelect: HTMLSelectElement | undefined;
  createEffect(() => { model(); models(); queueMicrotask(() => { if(modelSelect)modelSelect.value=model(); }); });
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loadError, setLoadError] = createSignal('');
  const [interrupting, setInterrupting] = createSignal(false);
  const query = () => `/api/chat?projectId=${props.projectId}${props.taskId === undefined ? '' : `&taskId=${props.taskId}&phase=${props.phase}`}`;
  let scrollport!: HTMLDivElement, scrollContent!: HTMLDivElement;
  let bottomFollow: ReturnType<typeof followChatBottom> | undefined;
  const sizeSuggestions = () => {
    if (!textarea) return;
    let top = 8;
    for (let ancestor = textarea.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (/^(hidden|auto|scroll|clip)$/.test(window.getComputedStyle(ancestor).overflowY)) top = Math.max(top,ancestor.getBoundingClientRect().top);
    }
    setSuggestionHeight(Math.max(40,Math.min(256,textarea.getBoundingClientRect().top - top - 8)));
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
    const hadModels = !!untrack(() => status() || modelStatus('claude'));
    let active = true, sequence = 0,fetching=false,reload=false;
    const sync = new ChatSync({ projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }) }, packs => { if (active) setPackState('value', reconcile(packs, {key: 'packId'})); }, message => { if (active) setSyncError(message); });
    const updateDraft = () => { setText(draft.text); setSending(draft.sending); setCommandSending(!!draft.commandSending); setPendingCommandName(draft.commandName ?? 'compact'); setError(draft.error); };
    draft.listeners.add(updateDraft);
    setConversation(undefined); setLocalResult(undefined); setConnected(false); setSuggestionsDismissed(false); setActiveSuggestion(-1); updateDraft(); setLoadError(''); setSyncError(''); setInterrupting(false);
    const load = async () => {
      if(fetching){reload=true;return}fetching=true;
      do {reload=false;
      const request = ++sequence;
      try { const value = await api<Conversation>(url, undefined, controller.signal); if (active && request === sequence) { if (!untrack(() => selectedModel(currentKey)) && value.selectedModel) { chooseModel(currentKey, value.selectedModel); if (hadModels && !untrack(() => modelIsAvailable(currentKey)) && modelRefreshRequested) {modelRefreshRequested = false; void loadModels(true, value.selectedModel.provider ?? 'codex').catch(() => {});} } sync.conversation(value.id); setConversation(value); setLoadError(''); } }
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
        restoreDraft(draft, content);
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
  async function runClientCommand(definition: ChatCommandDefinition, args: string): Promise<string> {
    if (args && !['model','rename'].includes(definition.name)) throw new Error(`${definition.command} に引数は指定できません。`);
    const value = conversation()!;
    switch (definition.name) {
      case 'help': return permittedCommands().map(item => `${item.command}${item.argumentHint ? ` ${item.argumentHint}` : ''} · ${item.description}${item.aliases?.length ? ` (別名: ${item.aliases.map(alias => `/${alias}`).join(', ')})` : ''}`).join('\n');
      case 'status': return `選択: ${selection() ? modelLabel(selection()!.id, selectedProvider()) : '未選択'}\n保存された接続先: ${value.sessionProvider ? providerName(value.sessionProvider) : '未開始'}\nメッセージ数: ${value.messages.length}\nモデル接続: ${selection() && providerReady(selectedProvider()) ? '利用可能' : '利用不可'}\n更新接続: ${connected() ? '接続済み' : '未接続'}`;
      case 'model': {
        if (!args) return 'モデルを選択してください。';
        const explicitProvider = args.match(/^(codex|claude)[/:]/i)?.[1]?.toLowerCase();
        const requestedName = explicitProvider ? args.slice(explicitProvider.length + 1) : args;
        const candidates = models().filter(item => providerReady(item.provider) && (explicitProvider ? item.provider === explicitProvider : !selectedProvider() || item.provider === selectedProvider()) && [item.id,item.name].includes(requestedName));
        if (candidates.length !== 1) throw new Error(candidates.length ? 'モデル名が曖昧です。接続先/モデルIDで指定してください。' : '指定したモデルを利用できません。');
        chooseModel(key(),candidates[0]); return `モデルを ${modelLabel(candidates[0].name,candidates[0].provider)} に変更しました。`;
      }
      case 'copy': {
        const message = value.messages.findLast(item => item.role === 'assistant' && item.status === 'completed' && item.content.trim());
        if (!message) throw new Error('コピーできる完了した回答がありません。');
        try { await navigator.clipboard.writeText(message.content); } catch { throw new Error('回答をコピーできませんでした。'); }
        return '最後の回答をコピーしました。';
      }
      case 'export': {
        const markdown = value.messages.map(message => `## ${message.role === 'user' ? 'あなた' : 'アシスタント'} · ${stateLabel[message.status]}\n\n${message.content}`).join('\n\n');
        const url = URL.createObjectURL(new Blob([markdown],{type:'text/markdown;charset=utf-8'}));
        try { const link = document.createElement('a'); link.href = url; link.download = `chat-${value.id}.md`; link.click(); }
        finally { URL.revokeObjectURL(url); }
        return '会話を書き出しました。';
      }
      case 'rename': {
        if (!props.taskId) throw new Error('タスクの会話でのみ名前を変更できます。');
        if (!args) throw new Error('/rename に名前を指定してください。');
        const task = await api<Task>(`/api/tasks/${encodeURIComponent(props.taskId)}/rename`,{projectId:props.projectId,name:args});
        props.onTaskRename?.(task); return `名前を「${task.name}」に変更しました。`;
      }
      default: throw new Error('不明なコマンドです。');
    }
  }
  const submitBlocked = () => {
    const parsed = commandInput();
    if (!parsed) return !validInstructionFocus() || !modelAvailable();
    const definition = findChatCommand(parsed.name,selectedProvider()) ?? (!selection() ? findChatCommand(parsed.name,'codex') ?? findChatCommand(parsed.name,'claude') : undefined);
    return definition?.kind === 'operation' ? !modelAvailable() : definition?.kind === 'message' ? props.projectId === 'instructions' || !validInstructionFocus() || !modelAvailable() : false;
  };
  async function send(event: SubmitEvent) {
    event.preventDefault();
    const currentKey = key(), draft = draftFor(currentKey), content = draft.text, version = draft.version, sentModel = selection(), sentInstructionFocus = props.instructionFocus;
    if (props.readOnly || draft.sending || busy() || !conversation() || loadError() || !content.trim()) return;
    const command = parseChatCommand(content);
    if (command) {
      const definition = findChatCommand(command.name, selectedProvider());
      if (!definition || definition.name === 'rename' && !props.taskId || definition.kind === 'message' && props.projectId === 'instructions') {
        draft.error = '不明なコマンドです。'; draft.listeners.forEach(listener => listener()); return;
      }
      if (definition.kind === 'client') {
        draft.sending = true; draft.error = ''; draft.listeners.forEach(listener => listener());
        try {
          const output = await runClientCommand(definition, command.args);
          if (draft.version === version) draft.text = '';
          if (key() === currentKey) setLocalResult({name:definition.command, output});
        } catch (error) { draft.error = error instanceof Error ? error.message : 'コマンドを実行できませんでした。'; }
        finally {
          draft.sending = false; draft.listeners.forEach(listener => listener());
          if (key() === currentKey && definition.name === 'model' && !command.args) { modelSelect?.focus(); try { modelSelect?.showPicker?.(); } catch { /* 未対応の環境ではフォーカスのみ移す。 */ } }
        }
        return;
      }
      if (definition.kind === 'operation') {
        if (command.args) { draft.error = `${definition.command} に引数は指定できません。`; draft.listeners.forEach(listener => listener()); return; }
        if (!sentModel || !modelAvailable()) return;
        if (definition.name === 'clear' && !window.confirm('現在の会話をリセットしますか？履歴はアーカイブに残ります。')) return;
        draft.sending = true; draft.commandSending = true; draft.commandName = definition.name; draft.error = ''; draft.listeners.forEach(listener => listener());
        try {
          const accepted = await api<{command: ChatCommand}>('/api/chat/commands', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : {phase: props.phase}), command: definition.name, args:'', provider:sentModel.provider ?? 'codex', model:sentModel.id });
          if (draft.version === version) draft.text = '';
          if (definition.name === 'clear') draft.pending = undefined;
          if (key() === currentKey && conversation()) setConversation({...conversation()!, command: accepted.command});
          draft.refresh?.();
        } catch (error) {
          draft.error = error instanceof ApiError && error.status >= 400 && error.status < 500 ? `${commandLabel(definition.name)}できませんでした: ${error.message}` : `${commandLabel(definition.name)}を確認できませんでした。状態を確認してください。`;
          draft.refresh?.();
        } finally {
          draft.sending = false; draft.commandSending = false; draft.listeners.forEach(listener => listener());
        }
        return;
      }
    }
    if (!validInstructionFocus() || !modelAvailable()) return;
    draft.sending = true; draft.error = ''; draft.listeners.forEach(listener => listener());
    try {
      draft.pending = {content, version};
      const accepted = await api<Conversation>('/api/chat/send', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }), ...(props.projectId === 'instructions' ? {instructionFocus: sentInstructionFocus} : {}), content, model: sentModel!.id, provider: sentModel!.provider ?? 'codex' });
      if (draft.pending) { draft.pending.sendId = accepted.messages?.findLast(message => message.role === 'user')?.sendId; if (draft.version === version) draft.text = ''; }
      draft.listeners.forEach(listener => listener());
      draft.refresh?.();
    } catch (error) {
      draft.pending = undefined;
      if (error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE') { rejectModel(currentKey, sentModel!.id, sentModel!.provider); restoreDraft(draft, content); }
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
    <Show when={status()?.auth === 'none'}><p class="px-4 pt-3 text-sm">Codex にログインしてください。</p></Show>
    <Show when={status() && !status()!.installed}><p class="px-4 pt-3 text-sm">Codex CLI をインストールしてください。</p></Show>
    <Show when={status()?.auth === 'apiKey' || status()?.auth === 'other'}><p class="px-4 pt-3 text-sm">Codex はサブスクリプション以外の認証方式です。設定を確認してください。</p></Show>
    <Show when={loadError()}><p role="alert" class="px-4 pt-3 text-sm text-error">{loadError()}</p></Show>
    <Show when={syncError()}><p role="alert" class="px-4 pt-3 text-sm text-error">{syncError()} <button class="btn btn-xs" onClick={() => refresh()}>更新</button></p></Show>
    <div ref={scrollport} class="min-h-0 flex-1 overflow-y-auto p-5" role="log" aria-label="チャット履歴" aria-live="polite">
      <div ref={scrollContent} class="space-y-3">
        <Show when={packState.value.length} fallback={<p class="text-sm text-base-content/50">希望や回答を入力してください。</p>}><For each={packState.value}>{pack => <article class={`chat ${pack.role === 'user' ? 'chat-end' : 'chat-start'}`}><div class="chat-header text-xs text-base-content/60">{pack.role === 'user' ? 'あなた' : 'アシスタント'} · {pack.model ? modelLabel(pack.model, pack.provider) : providerName(pack.provider)}</div><div class={`chat-bubble min-w-0 ${pack.role === 'user' ? 'chat-bubble-primary' : 'bg-base-200 text-base-content'}`}><Show when={pack.kind === 'tool'} fallback={<p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{pack.content}</p>}><details><summary>{pack.tool?.name ?? 'ツール'}</summary><pre class="whitespace-pre-wrap break-words text-xs">{pack.tool?.input}</pre><pre class="whitespace-pre-wrap break-words text-xs">{pack.tool?.output}</pre></details></Show></div><div class="chat-footer text-xs text-base-content/60">{stateLabel[pack.status]}</div></article>}</For></Show>
        <Show when={visibleCommandId()} keyed>{id => <div class="flex min-w-0 items-start gap-2 rounded-box border border-base-300 px-3 py-2 text-sm">
          <Show when={conversation()?.command?.output} fallback={<p role="status" class="min-w-0 flex-1">{commandOutcome()}</p>}>
            <details class="min-w-0 flex-1"><summary class="cursor-pointer truncate">{commandOutcome()}</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{conversation()?.command?.output}</pre></details>
          </Show>
          <button type="button" class="btn btn-ghost btn-xs shrink-0" aria-label="コマンド結果を閉じる" onClick={() => dismissCommand(id)}>×</button>
        </div>}</Show>
        <Show when={localResult()} keyed>{result => <div class="flex min-w-0 items-start gap-2 rounded-box border border-base-300 px-3 py-2 text-sm">
          <details class="min-w-0 flex-1"><summary class="cursor-pointer truncate">{result.name} · 結果</summary><pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{result.output}</pre></details>
          <button type="button" class="btn btn-ghost btn-xs shrink-0" aria-label="ローカルコマンド結果を閉じる" onClick={() => setLocalResult(undefined)}>×</button>
        </div>}</Show>
      </div>
    </div>
    <Show when={busy()}><div role="status" class="mx-4 mb-3 self-start"><div class="aura text-primary motion-reduce:animate-none"><div class="card bg-base-100 px-4 py-2 text-sm text-base-content">{compacting() ? `${commandProgress()}…` : '作業中…'}</div></div></div></Show>
    <Show when={latestOutcome()}><p role="status" class="mx-4 mb-2 text-sm">直近の応答: {latestOutcome()}</p></Show>
    <Show when={error()}><p role="alert" class="mx-4 mb-2 text-sm text-error">{error()}</p></Show>
    <Show when={!props.readOnly}><form class="border-t border-base-300 p-4" onSubmit={send}>
      <div class="relative">
        <textarea ref={textarea} class="textarea textarea-bordered block min-h-24 w-full resize-y" aria-label="希望や回答を入力" placeholder="希望や回答を入力" aria-autocomplete="list" aria-controls={suggestions().length ? commandListId : undefined} aria-expanded={!!suggestions().length} aria-activedescendant={suggestions().length && activeSuggestion() >= 0 ? `${commandListId}-${activeSuggestion()}` : undefined} required value={text()} onInput={event => { setCommandInputFocused(true); updateText(event.currentTarget.value); }} onKeyDown={commandKeyDown} onFocus={() => { setCommandInputFocused(true); setSuggestionsDismissed(false); }} onBlur={() => setCommandInputFocused(false)} />
        <Show when={suggestions().length}><ul id={commandListId} role="listbox" aria-label="スラッシュコマンド" style={{'max-height':`${suggestionHeight()}px`}} class="absolute bottom-full left-0 z-50 mb-2 w-72 max-w-full overflow-y-auto overscroll-contain rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"><For each={suggestions()}>{(item, index) => <li role="none"><button id={`${commandListId}-${index()}`} role="option" aria-selected={activeSuggestion() === index()} type="button" class={`w-full rounded px-3 py-2 text-left text-sm hover:bg-base-200 ${activeSuggestion() === index() ? 'bg-base-200' : ''}`} onMouseDown={event => event.preventDefault()} onClick={() => acceptSuggestion(index())}>{item.command} · {item.description}</button></li>}</For></ul></Show>
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-end gap-2"><Show when={props.projectId==='instructions'}><span class="mr-auto text-xs text-base-content/70">フォーカス: {props.instructionFocusLabel ?? '未選択'}</span></Show><select ref={modelSelect} class="select select-bordered select-sm w-auto" style={{ 'field-sizing': 'content' }} aria-label="モデル" value={model()} disabled={busy() || !models().length} onChange={event => selectModel(event.currentTarget.value)}><Show when={model() && !modelAvailable()}><option value={model()} selected disabled>⚠️ {modelLabel(selection()?.name ?? model(), selection()?.provider)}</option></Show><Show when={models().length} fallback={<Show when={!model()}><option value="">未確認</option></Show>}><For each={models().filter(item => modelAvailable() || modelValue(item) !== model())}>{item => <option value={modelValue(item)} selected={modelValue(item) === model()} disabled={!providerReady(item.provider)}>{modelLabel(item.name, item.provider)}</option>}</For></Show></select><Show when={busy()}><button type="button" class="btn btn-sm" disabled={interrupting()} onClick={interrupt}>中断</button></Show><button class="btn btn-primary btn-sm" type="submit" disabled={submitBlocked() || busy() || !text().trim() || !conversation() || !!loadError()}>{busy() ? (compacting() ? `${commandProgress()}...` : '応答中...') : '送信'}</button></div>
    </form></Show>
  </>;
}
