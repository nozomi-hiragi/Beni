import { createSignal, createUniqueId, For, Match, Show, Switch } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { ManualToolDefinition } from '../../shared/manual-tools';
import { validateManualToolInput as schemaError } from '../../shared/manual-tools';

type Schema = Record<string, unknown>;
type Field = { name: string; schema: Schema; required: boolean };
type Value = { enabled: boolean; nullValue: boolean; text: string; checked: boolean };
const object = (value: unknown): value is Schema => value !== null && typeof value === 'object' && !Array.isArray(value);

const valueKeywords = new Set(['type', 'title', 'description', 'default', 'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'items', 'minItems', 'maxItems', 'properties', 'required', 'additionalProperties']);
const rootKeywords = new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties']);
const kinds = (schema: Schema) => Array.isArray(schema.type) ? schema.type : [schema.type];

function fieldsFor(schema: Schema): Field[] | undefined {
  if (schema.type !== 'object' || !object(schema.properties) || schema.additionalProperties !== false || Object.keys(schema).some(key => !rootKeywords.has(key))) return;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some(name => typeof name !== 'string' || !Object.hasOwn(schema.properties as Schema, name))) return;
  return Object.entries(schema.properties).map(([name, schema]) => ({ name, schema: object(schema) ? schema : {}, required: required.includes(name) }));
}

function inputKind(schema: Schema) {
  if (Object.keys(schema).some(key => !valueKeywords.has(key))) return 'json';
  if (Array.isArray(schema.enum)) return 'enum';
  const nonNull = kinds(schema).filter(type => type !== 'null');
  return nonNull.length === 1 && ['string', 'integer', 'number', 'boolean'].includes(String(nonNull[0])) ? nonNull[0] : 'json';
}

function nullable(schema: Schema) {
  return Array.isArray(schema.enum) ? schema.enum.includes(null) : kinds(schema).includes('null');
}

function initialValue(field: Field): Value {
  return { enabled: field.required, nullValue: false, text: '', checked: false };
}

function parse(field: Field, value: Value) {
  if (value.nullValue) return null;
  switch (inputKind(field.schema)) {
    case 'enum':
      if (!value.text) throw Error('値を選択してください');
      return (field.schema.enum as unknown[])[Number(value.text)];
    case 'number':
    case 'integer':
      if (!value.text.trim() || !Number.isFinite(Number(value.text))) throw Error('数値を入力してください');
      return Number(value.text);
    case 'boolean':
      return value.checked;
    case 'string':
      return value.text;
    default:
      try { return JSON.parse(value.text); } catch { throw Error('JSON を入力してください'); }
  }
}

const multiline = /(?:^|_)(?:content|text|reason|body)(?:_|$)/;

export default function ToolArguments(props: { tool: ManualToolDefinition; disabled: boolean; onBack: () => void; onRun: (input: Schema) => void }) {
  const prefix = createUniqueId();
  const fields = fieldsFor(props.tool.inputSchema);
  const [values, setValues] = createStore(fields?.map(initialValue) ?? []);
  const [raw, setRaw] = createSignal('{}');
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [formError, setFormError] = createSignal('');
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (props.disabled) return;
    const messages: Record<string, string> = Object.create(null);
    const entries: [string, unknown][] = [];
    setFormError('');
    let input: Schema;
    if (fields) {
      for (const [index, field] of fields.entries()) {
        if (!values[index].enabled) continue;
        try {
          const value = parse(field, values[index]);
          const error = schemaError(field.schema, value);
          if (error) messages[field.name] = error;
          else entries.push([field.name, value]);
        } catch (error) {
          messages[field.name] = error instanceof Error ? error.message : '入力を確認してください';
        }
      }
      input = Object.fromEntries(entries);
    } else {
      try {
        const value: unknown = JSON.parse(raw());
        if (!object(value)) throw Error();
        input = value;
      } catch {
        setFormError('引数を JSON オブジェクトで入力してください');
        return;
      }
    }
    setErrors(messages);
    if (Object.keys(messages).length) return;
    const error = schemaError(props.tool.inputSchema, input);
    if (error) { setFormError(error); return; }
    props.onRun(input);
  }

  return <form class="flex flex-col gap-4" onSubmit={submit} novalidate>
    <For each={fields}>{(field, index) => {
      const id = () => `${prefix}-${index()}`;
      const value = () => values[index()];
      const error = () => Object.hasOwn(errors(), field.name) ? errors()[field.name] : undefined;
      const kind = inputKind(field.schema);
      const editText = (text: string) => setValues(index(), 'text', text);
      const fieldDisabled = () => props.disabled || !value().enabled || value().nullValue;
      const describedBy = () => error() ? `${id()}-help ${id()}-error` : `${id()}-help`;
      return <fieldset class="fieldset min-w-0 rounded-box border border-base-300 px-3 py-2">
        <legend class="fieldset-legend break-all">{field.name} <span class="font-normal">{field.required ? '（必須）' : '（任意）'}</span></legend>
        <Show when={!field.required}>
          <label class="label"><input type="checkbox" class="checkbox checkbox-sm" aria-label={`${field.name} を指定する`} checked={value().enabled} disabled={props.disabled} onChange={event => setValues(index(), 'enabled', event.currentTarget.checked)} />指定する</label>
        </Show>
        <Show when={nullable(field.schema) && kind !== 'enum'}>
          <label class="label"><input type="checkbox" class="checkbox checkbox-sm" aria-label={`${field.name} に null を指定`} checked={value().nullValue} disabled={props.disabled || !value().enabled} onChange={event => setValues(index(), 'nullValue', event.currentTarget.checked)} />null を指定</label>
        </Show>
        <p id={`${id()}-help`} class="break-words text-base-content/70">
          <Show when={kind === 'json'}>{kinds(field.schema).filter(Boolean).join(' / ') || '値'} を JSON で入力。 </Show>
          {typeof field.schema.description === 'string' ? field.schema.description : ''}
          <Show when={Object.hasOwn(field.schema, 'default')}> 既定値 {JSON.stringify(field.schema.default)}</Show>
        </p>
        <Switch>
          <Match when={kind === 'enum'}>
            <select class="select w-full" aria-label={field.name} aria-describedby={describedBy()} aria-invalid={!!error()} disabled={fieldDisabled()} value={value().text} onChange={event => editText(event.currentTarget.value)}>
              <option value="">選択してください</option>
              <For each={field.schema.enum as unknown[]}>{(option, i) => <option value={String(i())}>{typeof option === 'string' && option !== '' ? option : JSON.stringify(option)}</option>}</For>
            </select>
          </Match>
          <Match when={kind === 'boolean'}>
            <label class="label"><input type="checkbox" class="toggle toggle-sm" aria-label={field.name} aria-describedby={describedBy()} aria-invalid={!!error()} checked={value().checked} disabled={fieldDisabled()} onChange={event => setValues(index(), 'checked', event.currentTarget.checked)} />{value().checked ? 'オン' : 'オフ'}</label>
          </Match>
          <Match when={kind === 'json' || kind === 'string' && multiline.test(field.name)}>
            <textarea class="textarea w-full" classList={{ 'font-mono': kind === 'json' }} rows={4} aria-label={field.name} aria-describedby={describedBy()} aria-invalid={!!error()} disabled={fieldDisabled()} value={value().text} onInput={event => editText(event.currentTarget.value)} />
          </Match>
          <Match when={true}>
            <input class="input w-full" type={kind === 'integer' || kind === 'number' ? 'number' : 'text'} step={kind === 'integer' ? 1 : 'any'} min={typeof field.schema.minimum === 'number' ? field.schema.minimum : undefined} max={typeof field.schema.maximum === 'number' ? field.schema.maximum : undefined} aria-label={field.name} aria-describedby={describedBy()} aria-invalid={!!error()} disabled={fieldDisabled()} value={value().text} onInput={event => editText(event.currentTarget.value)} />
          </Match>
        </Switch>
        <Show when={error()}><p id={`${id()}-error`} role="alert" class="text-error">{error()}</p></Show>
      </fieldset>;
    }}</For>
    <Show when={!fields}>
      <label class="flex flex-col gap-2">引数（JSON オブジェクト）
        <textarea class="textarea w-full font-mono" rows={6} value={raw()} disabled={props.disabled} onInput={event => setRaw(event.currentTarget.value)} />
      </label>
    </Show>
    <Show when={formError()}><p role="alert" class="text-error">{formError()}</p></Show>
    <div class="flex flex-wrap justify-end gap-2">
      <button type="button" class="btn btn-ghost" onClick={props.onBack}>一覧へ戻る</button>
      <button type="submit" class="btn btn-primary" disabled={props.disabled}>実行</button>
    </div>
  </form>;
}
