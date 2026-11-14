import { validateManualToolInput } from '../shared/manual-tools';
import { validChatId } from '../shared/ids';
import { INSTRUCTIONS_CHAT_ID } from '../shared/communication';
import type { Conversation, Message } from './chat-history';
import { DocumentConflictError, type DocumentItemInput, type DocumentSource, type DocumentVersion } from './document-table';
import { ManualToolInputError, type EmbeddedTool } from './embedded-tools';
import { instructionKeys, instructionNames, instructionVariables, isInstructionKey, validateInstruction, type InstructionKey } from './instructions';

const string = { type: 'string' };
const cursor = { type: 'integer', minimum: 0 };
const sourceKind = { type: 'string', enum: ['instruction', 'message'] };
const keySchema = { type: 'string', enum: instructionKeys };
const object = (properties: Record<string, unknown>, required: string[] = []) =>
 ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, inputSchema: Record<string, unknown>): EmbeddedTool =>
 ({ type: 'function', name, description, inputSchema });
const sourceFields = { kind: sourceKind, id: string, revision: string };
const quoteSchema = object({ ...sourceFields, start: cursor, text: string }, ['kind', 'id', 'text']);
const editSchema = object({
 id: string, text: string, reason: string, sources: { type: 'array', items: quoteSchema, maxItems: 32 },
 index: cursor, remove: { type: 'boolean' },
});

export const instructionTools = [
 tool('list_instructions', '編集対象のキーと表示名を取得する。', object({})),
 tool('get_instruction', '指示の版と未展開の項目を取得する。item は0始まりの項目番号、offset は項目本文内の UTF-16 位置。項目には ID、採用理由、保存済み引用、原文を読むための source が含まれる。続きは返された revision と next を渡す。',
  object({ key: keySchema, revision: string, item: cursor, offset: cursor }, ['key'])),
 tool('list_chat_sources', '現在の編集相談チャットの発言を新しい順に取得する。引用する発言は read_source に kind と id を渡して原文を読む。',
  object({ offset: cursor })),
 tool('read_source', '編集相談の発言または指示項目の原文を分割取得する。指示項目は kind、id、revision、発言は kind と id を指定する。続きは next を offset に渡す。',
  object({ ...sourceFields, offset: cursor }, ['kind', 'id'])),
 tool('update_instruction', 'key、get_instruction で取得した最新版の revision、項目単位の edits を渡す。新規は id を省略、削除は id と remove:true を指定。index は0始まりの挿入・移動位置。空白以外の本文を追加・変更する際は reason と read_source で確認した原文引用 sources が必須。既存の項目は本文を変えずに理由や引用のみ変更できる。template・legacy の根拠で保存された項目の理由を変える場合は、項目の版または発言を引用し直す。成功時は key、revision、既知の置換変数の全出現位置 variables を返す。',
  object({ key: keySchema, revision: string, edits: { type: 'array', items: editSchema, minItems: 1, maxItems: 32 } }, ['key', 'revision', 'edits'])),
];

export const instructionToolsVersion = 2;

type SourceReference = { kind: 'instruction' | 'message'; id: string; revision?: string };
type Quote = SourceReference & { text: string; start?: number };
type Edit = Partial<Omit<DocumentItemInput, 'sources'>> & { sources?: Quote[]; index?: number; remove?: boolean };
type EditorStore = {
 read: (key: InstructionKey, revision?: string) => DocumentVersion | undefined;
 write: (key: InstructionKey, revision: string, items: DocumentItemInput[]) => DocumentVersion;
};
type EditorChat = (id?: string) => Pick<Conversation, 'id' | 'messages'> | undefined;

const pageSize = 20;
const chunkSize = 4096;
const quotePreviewSize = 256;
const chatPreviewSize = 160;

function insideSurrogatePair(text: string, offset: number) {
 return offset > 0 && /[\ud800-\udbff][\udc00-\udfff]/.test(text.slice(offset - 1, offset + 1));
}

function endOfChunk(text: string, offset: number, size: number) {
 const end = Math.min(offset + size, text.length);
 return insideSurrogatePair(text, end) ? end - 1 : end;
}

function chunk(text: string, offset: number) {
 if (offset > text.length || insideSurrogatePair(text, offset)) throw new ManualToolInputError('原文の取得位置を確認してください');
 const end = endOfChunk(text, offset, chunkSize);
 return { text: text.slice(offset, end), next: end < text.length ? end : null };
}

function identifier(value: string) {
 if (!value.trim() || Buffer.byteLength(value) > 256 || value.includes('\0')) throw new ManualToolInputError('参照 ID または版を確認してください');
 return value;
}

function quotable(message: Message) {
 return message.content.trim() && !message.systemGenerated && (message.role === 'user' || message.status === 'completed');
}

function listSources(conversation: ReturnType<EditorChat>, offset: number) {
 const sources = [];
 if (!conversation) return { sources: [], next: null };
 let seen = 0;
 const { messages } = conversation;
 for (let i = messages.length - 1; i >= 0; i--) {
  const message = messages[i]!;
  if (!quotable(message) || seen++ < offset) continue;
  if (sources.length === pageSize) return { sources, next: offset + pageSize };
  sources.push({
   kind: 'message', id: INSTRUCTIONS_CHAT_ID + '/' + conversation.id + '/' + message.id, role: message.role,
   excerpt: message.content.slice(0, endOfChunk(message.content, 0, chatPreviewSize)),
  });
 }
 return { sources, next: null };
}

function readSource(store: EditorStore, chat: EditorChat, ref: SourceReference) {
 const [scope, id, messageId, ...rest] = identifier(ref.id).split('/');
 let text: string | undefined;
 if (ref.kind === 'instruction') {
  if (ref.revision === undefined) throw new ManualToolInputError('指示項目の参照には revision が必要です');
  if (isInstructionKey(scope) && id && messageId === undefined) {
   text = store.read(scope, identifier(ref.revision))?.items.find(item => item.id === id)?.text;
  }
 } else {
  if (ref.revision !== undefined) throw new ManualToolInputError('発言の参照には revision を指定できません');
  if (scope === INSTRUCTIONS_CHAT_ID && validChatId(id) && messageId && !rest.length) {
   const message = chat(id)?.messages.find(item => item.id === messageId);
   if (message && quotable(message)) text = message.content;
  }
 }
 if (text === undefined) throw new ManualToolInputError('参照元が見つかりません');
 return text;
}

function verifyQuote(store: EditorStore, chat: EditorChat, { kind, id, revision, start, text }: Quote): DocumentSource {
 const original = readSource(store, chat, { kind, id, revision });
 const offset = start ?? original.indexOf(text);
 const end = offset + text.length;
 if (!text.trim() || Buffer.byteLength(text) > 64 * 1024 || offset < 0 ||
     original.slice(offset, end) !== text || insideSurrogatePair(original, offset) || insideSurrogatePair(original, end)) {
  throw new ManualToolInputError('引用が参照元の原文と一致しないか、引用のサイズが上限を超えています');
 }
 return { kind, id, revision, start: offset, text };
}

function readInstruction(store: EditorStore, { key, revision, item: itemIndex = 0, offset = 0 }: {
 key: InstructionKey; revision?: string; item?: number; offset?: number;
}) {
 const current = store.read(key, revision === undefined ? undefined : identifier(revision));
 if (!current) throw new ManualToolInputError('指定した版のインストラクションが見つかりません');
 const item = current.items[itemIndex];
 if (!item) return { key, revision: current.revision, item: null, next: null };
 const part = chunk(item.text, offset);
 const sources = item.sources.map(source => {
  const text = source.text.slice(0, endOfChunk(source.text, 0, quotePreviewSize));
  return { ...source, text, ...(text === source.text ? {} : { textTruncated: true, textLength: source.text.length }) };
 });
 const next = part.next !== null ? { item: itemIndex, offset: part.next } :
  itemIndex + 1 < current.items.length ? { item: itemIndex + 1, offset: 0 } : null;
 return {
  key, revision: current.revision, item: {
   id: item.id, text: part.text, reason: item.reason, sources,
   source: { kind: 'instruction', id: key + '/' + item.id, revision: current.revision },
  }, next,
 };
}

function updateInstruction(store: EditorStore, chat: EditorChat, { key, revision, edits }: {
 key: InstructionKey; revision: string; edits: Edit[];
}) {
 const current = store.read(key);
 if (current?.revision !== identifier(revision)) throw new DocumentConflictError();
 const items: DocumentItemInput[] = [...current.items];
 for (const { id, text, reason, sources, index, remove } of edits) {
  const at = id === undefined ? -1 : items.findIndex(item => item.id === id);
  if (id !== undefined && at < 0) throw new ManualToolInputError('編集する項目 ID を確認してください');
  const previous = at < 0 ? undefined : items.splice(at, 1)[0];
  if (remove) {
   if (!previous || [text, reason, sources, index].some(value => value !== undefined)) {
    throw new ManualToolInputError('削除には項目 ID と remove: true を指定してください');
   }
   continue;
  }
  const content = text ?? previous?.text;
  if (content === undefined) throw new ManualToolInputError('新しい項目には text が必要です');
  const textChanged = content !== previous?.text;
  if (textChanged && content.trim() && (!reason?.trim() || !sources?.length)) {
   throw new ManualToolInputError('空白以外の本文の追加・変更には reason と sources が必要です');
  }
  const position = index ?? (at < 0 ? items.length : at);
  if (position > items.length) throw new ManualToolInputError('項目の挿入・移動位置を確認してください');
  items.splice(position, 0, {
   id, text: content, reason: reason ?? (textChanged ? '' : previous!.reason),
   sources: sources?.map(source => verifyQuote(store, chat, source)) ?? (textChanged ? [] : previous!.sources),
  });
 }
 try {
  validateInstruction(key, items.map(item => item.text).join(''));
 } catch (error) {
  const message = error instanceof Error ? error.message : '';
  throw new ManualToolInputError(message.startsWith('本文は空でない') ? message : 'このインストラクションで使える置換変数を確認してください');
 }
 const saved = store.write(key, revision, items);
 return { key, revision: saved.revision, variables: instructionVariables(key, saved.content) };
}

export function runInstructionTool(store: EditorStore, chat: EditorChat, name: string, input: unknown) {
 const spec = instructionTools.find(tool => tool.name === name);
 if (!spec) throw new ManualToolInputError('この操作は利用できません');
 const error = validateManualToolInput(spec.inputSchema, input);
 if (error) throw new ManualToolInputError(error);
 switch (name) {
  case 'list_instructions': return { instructions: instructionKeys.map(key => ({ key, name: instructionNames[key] })) };
  case 'get_instruction': return readInstruction(store, input as Parameters<typeof readInstruction>[1]);
  case 'list_chat_sources': return listSources(chat(), (input as { offset?: number }).offset ?? 0);
  case 'read_source': {
   const ref = input as SourceReference & { offset?: number };
   return chunk(readSource(store, chat, ref), ref.offset ?? 0);
  }
  case 'update_instruction': return updateInstruction(store, chat, input as Parameters<typeof updateInstruction>[2]);
 }
}
