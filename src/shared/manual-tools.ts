import type { TaskPhase } from "./task-phase.ts";

export type ManualToolScope =
  | { kind: "project"; projectId: string; taskId?: string }
  | { kind: "instructions" };

export interface ManualToolDefinition {
  name: string;
  description: string;
  category: "events" | "documents" | "instructions";
  effect: "read" | "write" | "complete";
  inputSchema: Record<string, unknown>;
}

export interface ManualToolsCatalog {
  scope: ManualToolScope;
  label: string;
  phase: TaskPhase | null;
  revision: string;
  tools: ManualToolDefinition[];
  disabledReason?: string;
}

export interface ManualToolRequest {
  scope: ManualToolScope;
  revision: string;
  operationId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ManualToolOperation {
  id: string;
  scope: ManualToolScope;
  label: string;
  phase?: TaskPhase | null;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "interrupted" | "unknown";
  createdAt: string;
  updatedAt: string;
  output?: string;
  error?: string;
}

export interface ManualToolResponse {
  operation: ManualToolOperation;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const matchesType = (type: unknown, value: unknown): boolean => {
  switch (type) {
    case "object": return isObject(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    case "integer": return Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    default: return true;
  }
};

// 埋め込みツールのスキーマで使う制約をフォームと実行 API で共有する。
export function validateManualToolInput(
  schema: Record<string, unknown>, input: unknown, path = "入力",
): string | undefined {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some(type => matchesType(type, input))) return path + "の型を確認してください";
  if (Array.isArray(schema.enum) && !schema.enum.includes(input)) return path + "の値を選択肢から指定してください";
  if (typeof input === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(input)) {
    return path + "の形式を確認してください";
  }
  if (typeof input === "number" && (
    (typeof schema.minimum === "number" && input < schema.minimum) ||
    (typeof schema.maximum === "number" && input > schema.maximum)
  )) return path + "の範囲を確認してください";
  if (Array.isArray(input)) {
    if ((typeof schema.minItems === "number" && input.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && input.length > schema.maxItems)) return path + "の件数を確認してください";
    if (isObject(schema.items)) {
      for (const [index, item] of input.entries()) {
        const error = validateManualToolInput(schema.items, item, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (isObject(input)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (typeof field === "string" && !Object.hasOwn(input, field)) return `${path}.${field}は必須です`;
      }
    }
    for (const [field, value] of Object.entries(input)) {
      if (!Object.hasOwn(properties, field)) {
        if (schema.additionalProperties === false) return path + "に未定義の項目があります";
        continue;
      }
      const property = properties[field];
      if (isObject(property)) {
        const error = validateManualToolInput(property, value, `${path}.${field}`);
        if (error) return error;
      }
    }
  }
}
