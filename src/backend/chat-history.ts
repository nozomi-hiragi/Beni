import { isProvider, object, validPack, type ChatState, type Pack, type Provider } from '../shared/communication';
import { isTaskPhase, type TaskPhase } from '../shared/task-phase';
import type { ChatCommand } from '../shared/chat-commands';
import { contextUsageFromCounts, type ContextUsage } from '../shared/agent';
import { isInstructionKey, type InstructionKey } from './instructions';

export type State = ChatState;

export type Message = {
  id: string;
  sendId: string;
  role: 'user' | 'assistant';
  content: string;
  provider: Provider;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  status: ChatState;
  threadId: string | null;
  sessionId: string | null;
  systemGenerated?: true;
  errorCode?: 'MODEL_UNAVAILABLE';
};

export type Session = Pick<Message, 'threadId' | 'sessionId'> & {
  workflowToolsHash?: string;
  phaseReferenceHash?: string;
  instructionToolsVersion?: 1 | 2;
  eventToolsVersion?: 1;
  lastEventId: number;
  contextMessageCount?: number;
  contextUsage?: ContextUsage;
  lastInstructionFocusThreadId?: string;
  lastInstructionFocus?: InstructionKey;
  lastInstructionFocusHash?: string;
};

type ConversationFields = {
  id: string;
  projectId: string;
  taskId: string | null;
  phase: TaskPhase | null;
  packs: Pack[];
  workflowJobId?: string;
  command?: ChatCommand;
  appliedEditorContent?: string;
  folderGeneration?: number;
};

type ProviderNames = Record<Provider, { name: string; models: Record<string, string> }>;
const names = Symbol('chat history names');

export type Conversation = ConversationFields & Session & {
  version: 1;
  messages: Message[];
  selectedModel: { id: string; name: string; provider?: Provider } | null;
  sessionProvider?: Provider;
  sessions?: Partial<Record<string, Session>>;
  unassignedSessions?: Partial<Record<Provider, Session>>;
  [names]?: ProviderNames;
};

type ResumeIds = { resumeId: string | null; legacySessionId?: string };
type StoredSession = Omit<Session, 'threadId' | 'sessionId'> & ResumeIds;
type StoredPart = Omit<Pack, 'messageId' | 'sendId' | 'role' | 'provider' | 'model'> &
  Partial<Pick<Pack, 'sendId' | 'role' | 'model'>> & { provider?: Provider | null };
type StoredMessage = Omit<Message, 'content' | 'provider' | 'model' | 'threadId' | 'sessionId'> & {
  modelId: string | null;
  providerId?: Provider;
  parts: StoredPart[];
  contentOverride?: string;
};
type StoredModel = { name: string; session?: StoredSession; messageData?: Record<string, ResumeIds> };
type StoredProvider = {
  name: string;
  models: Record<string, StoredModel>;
  messageData?: Record<string, ResumeIds>;
  unassignedSession?: StoredSession & { active?: true };
};
export type StoredConversation = Omit<ConversationFields, 'packs' | 'id'> & {
  version: 3;
  chatId: string;
  selectedModelId: string | null;
  providers: Record<Provider, StoredProvider>;
  messages: StoredMessage[];
};

export function sessionSnapshot(c: Session): Session {
  const {
    threadId, sessionId, workflowToolsHash, phaseReferenceHash, instructionToolsVersion,
    eventToolsVersion, lastEventId, contextMessageCount, contextUsage, lastInstructionFocusThreadId,
    lastInstructionFocus, lastInstructionFocusHash,
  } = c;
  return {
    threadId, sessionId: sessionId ?? null, workflowToolsHash, phaseReferenceHash, instructionToolsVersion,
    eventToolsVersion, lastEventId, contextMessageCount, contextUsage, lastInstructionFocusThreadId,
    lastInstructionFocus, lastInstructionFocusHash,
  };
}

export const emptySession = (): Session => sessionSnapshot({ threadId: null, sessionId: null, lastEventId: 0 });
export const modelKey = (provider: Provider, model: string) => `${provider}/${model}`;

function invalid(): never {
  throw Error('Invalid history');
}

const dictionary = <T>(): Record<string, T> => Object.create(null);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseContextUsage(value: unknown): ContextUsage | undefined {
  if (!object(value)) return;
  return contextUsageFromCounts(value.usedTokens, value.maxTokens);
}

function modelParts(key: unknown): [Provider, string] {
  if (typeof key !== 'string') invalid();
  const slash = key.indexOf('/');
  if (slash < 0) invalid();
  const provider = key.slice(0, slash), model = key.slice(slash + 1);
  if (!isProvider(provider) || !model) invalid();
  return [provider, model];
}

function messageFields(value: Record<string, unknown>, content: unknown): Omit<Message, 'provider' | 'model' | 'threadId' | 'sessionId'> {
  const { id, sendId, role, createdAt, updatedAt, status, systemGenerated, errorCode } = value;
  if (!nonempty(id) || !nonempty(sendId) || (role !== 'user' && role !== 'assistant') ||
      typeof content !== 'string' || typeof createdAt !== 'string' || typeof updatedAt !== 'string' ||
      (status !== 'pending' && status !== 'streaming' && status !== 'completed' && status !== 'failed' &&
       status !== 'interrupted' && status !== 'unknown') ||
      (systemGenerated !== undefined && systemGenerated !== true) ||
      (errorCode !== undefined && errorCode !== 'MODEL_UNAVAILABLE')) invalid();
  return {
    id, sendId, role, content, createdAt, updatedAt, status,
    ...(systemGenerated === undefined ? {} : { systemGenerated }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function commandFields(value: unknown): ChatCommand | undefined {
  if (value === undefined) return;
  if (!object(value)) invalid();
  const { id, name, status, error, output } = value;
  if (!nonempty(id) || typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name) ||
      (status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'interrupted' && status !== 'unknown') ||
      !optionalString(error) || !optionalString(output) || (output !== undefined && Buffer.byteLength(output) > 65536)) invalid();
  return { id, name, status, ...(error === undefined ? {} : { error }), ...(output === undefined ? {} : { output }) };
}

function conversationFields(value: Record<string, unknown>): Omit<ConversationFields, 'packs'> {
  const { projectId, taskId, phase, appliedEditorContent, workflowJobId, folderGeneration } = value;
  const id = value.chatId ?? value.id;
  if (value.chatId !== undefined && value.id !== undefined && value.chatId !== value.id) invalid();
  if (!nonempty(id) || !nonempty(projectId) || (taskId !== null && !nonempty(taskId)) ||
      (phase !== null && !isTaskPhase(phase) && !(value.version === 1 && taskId === null && phase === undefined)) ||
      !optionalString(appliedEditorContent) || !optionalString(workflowJobId) || (folderGeneration !== undefined && !count(folderGeneration))) invalid();
  const command = commandFields(value.command);
  return {
    id, projectId, taskId, phase: phase ?? null,
    ...(appliedEditorContent === undefined ? {} : { appliedEditorContent }),
    ...(workflowJobId === undefined ? {} : { workflowJobId }),
    ...(folderGeneration === undefined ? {} : { folderGeneration }),
    ...(command === undefined ? {} : { command }),
  };
}

function resumeFields(resumeId: unknown, legacySessionId: unknown): Pick<Session, 'threadId' | 'sessionId'> {
  if ((resumeId !== null && !nonempty(resumeId)) || !optionalString(legacySessionId)) invalid();
  return { threadId: resumeId, sessionId: legacySessionId ?? null };
}

function sessionFields(value: Record<string, unknown>, messageCount: number, legacy: boolean): Session {
  const { workflowToolsHash, phaseReferenceHash, instructionToolsVersion, eventToolsVersion, contextMessageCount,
    lastInstructionFocusThreadId, lastInstructionFocus, lastInstructionFocusHash } = value;
  const lastEventId = legacy && value.lastEventId === undefined ? 0 : value.lastEventId;
  const ids = legacy ? resumeFields(value.threadId ?? null, value.sessionId ?? undefined)
    : resumeFields(value.resumeId, value.legacySessionId);
  const contextUsage = parseContextUsage(value.contextUsage);
  if (!count(lastEventId) || (contextMessageCount !== undefined && (!count(contextMessageCount) || contextMessageCount > messageCount)) ||
      (value.contextUsage !== undefined && (!contextUsage || ids.threadId === null)) ||
      !optionalString(workflowToolsHash) || !optionalString(phaseReferenceHash) ||
      (instructionToolsVersion !== undefined && instructionToolsVersion !== 1 && instructionToolsVersion !== 2) ||
      (eventToolsVersion !== undefined && eventToolsVersion !== 1) ||
      !optionalString(lastInstructionFocusThreadId) ||
      (lastInstructionFocus !== undefined && !isInstructionKey(lastInstructionFocus)) ||
      (lastInstructionFocusHash !== undefined && (typeof lastInstructionFocusHash !== 'string' || !/^[a-f0-9]{64}$/.test(lastInstructionFocusHash)))) invalid();
  return {
    ...ids, lastEventId,
    ...(workflowToolsHash === undefined ? {} : { workflowToolsHash }),
    ...(phaseReferenceHash === undefined ? {} : { phaseReferenceHash }),
    ...(instructionToolsVersion === undefined ? {} : { instructionToolsVersion }),
    ...(eventToolsVersion === undefined ? {} : { eventToolsVersion }),
    ...(contextMessageCount === undefined ? {} : { contextMessageCount }),
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...(lastInstructionFocusThreadId === undefined ? {} : { lastInstructionFocusThreadId }),
    ...(lastInstructionFocus === undefined ? {} : { lastInstructionFocus }),
    ...(lastInstructionFocusHash === undefined ? {} : { lastInstructionFocusHash }),
  };
}

function hasSessionState(session: Session): boolean {
  const { threadId, sessionId, lastEventId, ...rest } = sessionSnapshot(session);
  return threadId !== null || sessionId !== null || lastEventId !== 0 || Object.values(rest).some(value => value !== undefined);
}

function legacyConversation(value: Record<string, unknown>, fields: ConversationFields, rawMessages: unknown[]): Conversation {
  const ids = new Set<string>();
  const messages = rawMessages.map((raw): Message => {
    if (!object(raw)) invalid();
    const message = messageFields(raw, raw.content);
    if (ids.has(message.id)) invalid();
    ids.add(message.id);
    const provider = raw.provider === undefined ? 'codex' : raw.provider, model = raw.model ?? null;
    if (!isProvider(provider) || (model !== null && !nonempty(model))) invalid();
    return { ...message, provider, model, ...resumeFields(raw.threadId ?? null, raw.sessionId ?? undefined) };
  });
  let active = sessionFields(value, messages.length, true);
  const storedProvider = value.sessionProvider;
  if (storedProvider !== undefined && !isProvider(storedProvider)) invalid();
  let sessionProvider = storedProvider ?? (hasSessionState(active) ? 'codex' : undefined);

  let selectedModel: Conversation['selectedModel'] = null;
  const selected = value.selectedModel;
  if (selected !== undefined && selected !== null) {
    if (!object(selected) || !nonempty(selected.id) || typeof selected.name !== 'string' ||
        (selected.provider !== undefined && !isProvider(selected.provider))) invalid();
    selectedModel = { id: selected.id, name: selected.name, ...(selected.provider === undefined ? {} : { provider: selected.provider }) };
  }
  const matchingModel = (provider: Provider, session: Session) => {
    // 未受理の発言に前の再開 ID が書かれている場合がある。受理済みの位置があればそこで区切る。
    const through = session.contextMessageCount ?? messages.length;
    const historical = session.threadId === null ? undefined : messages.findLast((m, index) =>
      index < through && m.provider === provider && m.model !== null && m.threadId === session.threadId);
    return historical?.model ?? ((selectedModel?.provider ?? 'codex') === provider ? selectedModel?.id : undefined)
      ?? messages.findLast(m => m.provider === provider && m.model !== null)?.model;
  };
  const activeModel = sessionProvider === undefined ? undefined : matchingModel(sessionProvider, active);
  if (sessionProvider !== undefined && activeModel && !selectedModel) {
    selectedModel = { id: activeModel, name: activeModel, provider: sessionProvider };
  }

  const sessions = dictionary<Session>(), unassignedSessions = dictionary<Session>();
  if (value.sessions !== undefined) {
    if (!object(value.sessions)) invalid();
    for (const [key, raw] of Object.entries(value.sessions)) {
      if (!object(raw)) invalid();
      const session = sessionFields(raw, messages.length, true);
      if (isProvider(key)) {
        if (!session.threadId || raw.sessionId === undefined || raw.lastEventId === undefined) invalid();
        const model = matchingModel(key, session);
        if (!model) {
          unassignedSessions[key] = session;
          continue;
        }
        const composite = modelKey(key, model);
        if (Object.hasOwn(sessions, composite)) invalid();
        sessions[composite] = session;
      } else {
        modelParts(key);
        if (Object.hasOwn(sessions, key)) invalid();
        sessions[key] = session;
      }
    }
  }
  if (value.unassignedSessions !== undefined) {
    if (!object(value.unassignedSessions)) invalid();
    for (const [provider, raw] of Object.entries(value.unassignedSessions)) {
      if (!isProvider(provider) || !object(raw) || Object.hasOwn(unassignedSessions, provider)) invalid();
      unassignedSessions[provider] = sessionFields(raw, messages.length, true);
    }
  }
  if (sessionProvider !== undefined) {
    if (activeModel) {
      const key = modelKey(sessionProvider, activeModel);
      if (Object.hasOwn(sessions, key)) invalid();
      if (selectedModel?.id !== activeModel || (selectedModel.provider ?? 'codex') !== sessionProvider) {
        sessions[key] = active;
        active = { threadId: null, sessionId: null, lastEventId: 0 };
        sessionProvider = undefined;
      }
    } else if (Object.hasOwn(unassignedSessions, sessionProvider)) invalid();
  }
  const conversation: Conversation = {
    ...fields, ...active, version: 1, messages, selectedModel,
    ...(sessionProvider === undefined ? {} : { sessionProvider }),
    ...(Object.keys(sessions).length === 0 ? {} : { sessions }),
    ...(Object.keys(unassignedSessions).length === 0 ? {} : { unassignedSessions }),
  };
  if (selectedModel) {
    const provider = selectedModel.provider ?? 'codex';
    const providerNames = dictionary<ProviderNames[string]>(), models = dictionary<string>();
    models[selectedModel.id] = selectedModel.name;
    providerNames[provider] = { name: provider, models };
    Object.defineProperty(conversation, names, { value: providerNames });
  }
  return conversation;
}

function decodePart(raw: unknown, message: Message): Pack {
  if (!object(raw)) invalid();
  const {
    packId, sequence, kind, content, tool, createdAt, closedAt, status, state,
    sendId = message.sendId, role = message.role, model = message.model, provider = message.provider,
  } = raw;
  const pack = {
    packId, sequence, messageId: message.id, sendId, role, kind, content, tool, model, createdAt, status, state,
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(provider === null ? {} : { provider }),
  };
  if (typeof status !== 'string' || !validPack(pack)) invalid();
  return pack;
}

const bySequence = (a: Pack, b: Pack) => a.sequence - b.sequence;
const textContent = (packs: Pack[]) => packs.filter(pack => pack.kind === 'text').map(pack => pack.content).join('');

function storedConversation(value: Record<string, unknown>, fields: ConversationFields, rawMessages: unknown[]): Conversation {
  if (!object(value.providers)) invalid();
  const hasParts = value.version === 3;
  const selected = value.selectedModelId === null ? null : modelParts(value.selectedModelId);
  const providerNames = dictionary<ProviderNames[string]>();
  const sessions = dictionary<Session>(), unassignedSessions = dictionary<Session>();
  const messageData = new Map<string, { provider: Provider; model: string | null; ids: Pick<Session, 'threadId' | 'sessionId'> }>();
  let active: Session | undefined, sessionProvider: Provider | undefined;
  const setActive = (provider: Provider, session: Session) => {
    if (active) invalid();
    active = session;
    sessionProvider = provider;
  };
  const readMessageData = (provider: Provider, model: string | null, data: unknown) => {
    if (data === undefined) return;
    if (!object(data)) invalid();
    for (const [id, raw] of Object.entries(data)) {
      if (messageData.has(id) || !object(raw)) invalid();
      messageData.set(id, { provider, model, ids: resumeFields(raw.resumeId, raw.legacySessionId) });
    }
  };

  for (const [provider, raw] of Object.entries(value.providers)) {
    if (!isProvider(provider) || !object(raw) || typeof raw.name !== 'string' || !object(raw.models)) invalid();
    const models = dictionary<string>();
    providerNames[provider] = { name: raw.name, models };
    readMessageData(provider, null, raw.messageData);
    if (raw.unassignedSession !== undefined) {
      const data = raw.unassignedSession;
      if (!object(data) || (data.active !== undefined && data.active !== true)) invalid();
      const session = sessionFields(data, rawMessages.length, false);
      if (data.active) {
        if (selected?.[0] === provider) invalid();
        setActive(provider, session);
      } else {
        unassignedSessions[provider] = session;
      }
    }
    for (const [model, entry] of Object.entries(raw.models)) {
      if (!model || !object(entry) || typeof entry.name !== 'string') invalid();
      models[model] = entry.name;
      readMessageData(provider, model, entry.messageData);
      if (entry.session === undefined) continue;
      if (!object(entry.session)) invalid();
      const session = sessionFields(entry.session, rawMessages.length, false);
      if (provider === selected?.[0] && model === selected[1]) setActive(provider, session);
      else sessions[modelKey(provider, model)] = session;
    }
  }
  const knownModel = (provider: Provider, model: string) => {
    const entry = providerNames[provider];
    if (!entry || !Object.hasOwn(entry.models, model)) invalid();
    return entry.models[model];
  };
  const ids = new Set<string>();
  const messages = rawMessages.map((raw): Message => {
    if (!object(raw)) invalid();
    const message = messageFields(raw, hasParts ? '' : raw.content);
    if (ids.has(message.id)) invalid();
    ids.add(message.id);
    let provider: Provider, model: string | null;
    if (raw.modelId === null) {
      const id = raw.providerId === undefined ? 'codex' : raw.providerId;
      if (!isProvider(id)) invalid();
      provider = id;
      model = null;
    } else {
      [provider, model] = modelParts(raw.modelId);
      knownModel(provider, model);
      if (raw.providerId !== undefined) invalid();
    }
    const data = messageData.get(message.id);
    if (data && (data.provider !== provider || data.model !== model)) invalid();
    messageData.delete(message.id);
    const decoded: Message = { ...message, provider, model, ...(data?.ids ?? { threadId: null, sessionId: null }) };
    if (hasParts) {
      if (!Array.isArray(raw.parts) || !optionalString(raw.contentOverride)) invalid();
      const packs = raw.parts.map(part => decodePart(part, decoded)).sort(bySequence);
      for (const pack of packs) fields.packs.push(pack);
      decoded.content = raw.contentOverride ?? textContent(packs);
    }
    return decoded;
  });
  if (messageData.size) invalid();
  if (hasParts) {
    fields.packs.sort(bySequence);
    const packIds = new Set<string>();
    for (const [index, pack] of fields.packs.entries()) {
      if (pack.sequence !== index + 1 || packIds.has(pack.packId)) invalid();
      packIds.add(pack.packId);
    }
  }

  const selectedModel = selected ? { provider: selected[0], id: selected[1], name: knownModel(...selected) } : null;
  const conversation: Conversation = {
    ...fields, ...(active ?? { threadId: null, sessionId: null, lastEventId: 0 }), version: 1, messages, selectedModel,
    ...(sessionProvider === undefined ? {} : { sessionProvider }),
    ...(Object.keys(sessions).length === 0 ? {} : { sessions }),
    ...(Object.keys(unassignedSessions).length === 0 ? {} : { unassignedSessions }),
  };
  Object.defineProperty(conversation, names, { value: providerNames });
  return conversation;
}

export function decodeChatHistory(value: unknown): Conversation {
  if (!object(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || !Array.isArray(value.messages)) invalid();
  const { version, packs } = value;
  if (version === 3 ? packs !== undefined : !Array.isArray(packs)) invalid();
  const fields = { ...conversationFields(value), packs: Array.isArray(packs) ? packs : [] };
  return version === 1 ? legacyConversation(value, fields, value.messages) : storedConversation(value, fields, value.messages);
}

function encodeResumeIds(threadId: string | null, sessionId: string | null): ResumeIds {
  return { resumeId: threadId, ...(sessionId === null ? {} : { legacySessionId: sessionId }) };
}

function encodeSession(session: Session): StoredSession {
  const { threadId, sessionId, ...state } = sessionSnapshot(session);
  return { ...encodeResumeIds(threadId, sessionId), ...state };
}

function encodePart(pack: Pack, message: Message): StoredPart {
  const { messageId, sendId, role, provider, model, ...part } = pack;
  return {
    ...part,
    ...(sendId === message.sendId ? {} : { sendId }),
    ...(role === message.role ? {} : { role }),
    ...(provider === message.provider ? {} : { provider: provider ?? null }),
    ...(model === message.model ? {} : { model }),
  };
}

export function encodeChatHistory(c: Conversation, providerName?: (provider: Provider) => string | undefined): StoredConversation {
  const providers = dictionary<StoredProvider>();
  const providerEntry = (id: Provider) => providers[id] ??= {
    name: providerName?.(id) ?? c[names]?.[id]?.name ?? id,
    models: dictionary<StoredModel>(),
  };
  const modelEntry = (provider: Provider, model: string) => providerEntry(provider).models[model] ??= {
    name: c[names]?.[provider]?.models[model] ?? model,
  };
  for (const [provider, data] of Object.entries(c[names] ?? {})) {
    providerEntry(provider);
    for (const model of Object.keys(data.models)) modelEntry(provider, model);
  }
  const selected = c.selectedModel, selectedProvider = selected?.provider ?? 'codex';
  if (selected) modelEntry(selectedProvider, selected.id).name = selected.name;
  for (const [key, session] of Object.entries(c.sessions ?? {})) {
    if (session) modelEntry(...modelParts(key)).session = encodeSession(session);
  }
  for (const [provider, session] of Object.entries(c.unassignedSessions ?? {})) {
    if (session) providerEntry(provider).unassignedSession = encodeSession(session);
  }
  if (c.sessionProvider !== undefined || hasSessionState(c)) {
    const provider = c.sessionProvider ?? 'codex';
    if (selected && selectedProvider === provider) modelEntry(provider, selected.id).session = encodeSession(c);
    else providerEntry(provider).unassignedSession = { ...encodeSession(c), active: true };
  }

  const packsByMessage = new Map(c.messages.map(message => [message.id, [] as Pack[]]));
  if (packsByMessage.size !== c.messages.length) invalid();
  for (const pack of c.packs) {
    const packs = packsByMessage.get(pack.messageId);
    if (!packs) invalid();
    packs.push(pack);
  }
  const messages = c.messages.map((source): StoredMessage => {
    const { provider, model, threadId, sessionId, content, ...message } = source;
    const entry = model === null ? providerEntry(provider) : modelEntry(provider, model);
    if (threadId !== null || sessionId !== null) {
      entry.messageData ??= dictionary<ResumeIds>();
      entry.messageData[message.id] = encodeResumeIds(threadId, sessionId);
    }
    const packs = packsByMessage.get(message.id)!.sort(bySequence);
    return {
      ...message, modelId: model === null ? null : modelKey(provider, model),
      ...(model === null ? { providerId: provider } : {}),
      parts: packs.map(pack => encodePart(pack, source)),
      ...(content === textContent(packs) ? {} : { contentOverride: content }),
    };
  });
  const { id, projectId, taskId, phase, command, workflowJobId, appliedEditorContent, folderGeneration } = c;
  return {
    version: 3, chatId: id, projectId, taskId, phase, selectedModelId: selected ? modelKey(selectedProvider, selected.id) : null,
    providers, messages, command, workflowJobId, appliedEditorContent, folderGeneration,
  };
}
