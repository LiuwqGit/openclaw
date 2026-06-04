import type { AgentTool } from "./types.js";

const AGENT_TOOL_SCHEMA_MAX_DEPTH = 24;
const AGENT_TOOL_SCHEMA_MAX_NODES = 1_000;

class InvalidAgentToolSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentToolSnapshotError";
  }
}

interface AgentToolSchemaCloneState {
  readonly seen: WeakSet<object>;
  nodes: number;
}

export interface SnapshotAgentToolsOptions {
  logContext: string;
}

function describeAgentToolSnapshotError(error: unknown): string {
  if (error instanceof InvalidAgentToolSnapshotError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function readToolStringField(
  source: unknown,
  field: "name" | "description" | "label",
  options?: { nonEmpty?: boolean },
): string {
  const value = Reflect.get(Object(source), field, source);
  if (typeof value !== "string") {
    throw new InvalidAgentToolSnapshotError(`${field} must be a string`);
  }
  if (options?.nonEmpty === true && value.length === 0) {
    throw new InvalidAgentToolSnapshotError(`${field} must be non-empty`);
  }
  return value;
}

type BoundAgentToolFunction = (...args: unknown[]) => unknown;

function readToolFunctionField(
  source: unknown,
  field: "execute" | "prepareArguments",
  required: boolean,
): BoundAgentToolFunction | undefined {
  const value = Reflect.get(Object(source), field, source);
  if (value === undefined) {
    if (required) {
      throw new InvalidAgentToolSnapshotError(`${field} must be a function`);
    }
    return undefined;
  }
  if (typeof value !== "function") {
    throw new InvalidAgentToolSnapshotError(`${field} must be a function`);
  }
  return value.bind(source) as BoundAgentToolFunction;
}

function readToolExecutionMode(source: unknown): AgentTool["executionMode"] | undefined {
  const value = Reflect.get(Object(source), "executionMode", source);
  if (value === undefined || value === "parallel" || value === "sequential") {
    return value;
  }
  throw new InvalidAgentToolSnapshotError("executionMode must be parallel or sequential");
}

function cloneAgentToolSchema<TSchema>(schema: TSchema): TSchema {
  if (schema === undefined) {
    return schema;
  }
  return cloneAgentToolSchemaValue(schema, 0, {
    seen: new WeakSet<object>(),
    nodes: 0,
  }) as TSchema;
}

function cloneAgentToolSchemaValue(
  value: unknown,
  depth: number,
  state: AgentToolSchemaCloneState,
): unknown {
  state.nodes += 1;
  if (state.nodes > AGENT_TOOL_SCHEMA_MAX_NODES) {
    throw new InvalidAgentToolSnapshotError("parameters schema is too large");
  }
  if (depth > AGENT_TOOL_SCHEMA_MAX_DEPTH) {
    throw new InvalidAgentToolSnapshotError("parameters schema is too deep");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidAgentToolSnapshotError("parameters schema contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      throw new InvalidAgentToolSnapshotError("parameters schema contains a cycle");
    }
    state.seen.add(value);
    const cloned = value.map((entry) => cloneAgentToolSchemaValue(entry, depth + 1, state));
    state.seen.delete(value);
    return cloned;
  }
  if (typeof value !== "object") {
    throw new InvalidAgentToolSnapshotError("parameters schema must be JSON-schema compatible");
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new InvalidAgentToolSnapshotError("parameters schema must be a plain object");
  }
  if (state.seen.has(value)) {
    throw new InvalidAgentToolSnapshotError("parameters schema contains a cycle");
  }
  state.seen.add(value);

  const cloned = Object.create(proto) as Record<PropertyKey, unknown>;
  const keys: PropertyKey[] = [
    ...Object.getOwnPropertyNames(value),
    ...Object.getOwnPropertySymbols(value),
  ];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new InvalidAgentToolSnapshotError("parameters schema contains an accessor");
    }
    Object.defineProperty(cloned, key, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      writable: descriptor.writable,
      value: cloneAgentToolSchemaValue(descriptor.value, depth + 1, state),
    });
  }
  state.seen.delete(value);
  return cloned;
}

export function snapshotAgentTool<TTool extends AgentTool>(
  tool: TTool,
  index: number,
  options: SnapshotAgentToolsOptions,
): TTool | undefined {
  let name = `tool[${index}]`;
  try {
    name = readToolStringField(tool, "name", { nonEmpty: true });
    const description = readToolStringField(tool, "description");
    const label = readToolStringField(tool, "label");
    const parameters = cloneAgentToolSchema(Reflect.get(Object(tool), "parameters", tool));
    const execute = readToolFunctionField(tool, "execute", true) as AgentTool["execute"];
    const prepareArguments = readToolFunctionField(
      tool,
      "prepareArguments",
      false,
    ) as AgentTool["prepareArguments"];
    const executionMode = readToolExecutionMode(tool);
    const snapshot = Object.create(tool) as TTool;
    Object.defineProperties(snapshot, {
      name: { configurable: true, enumerable: true, writable: false, value: name },
      description: { configurable: true, enumerable: true, writable: false, value: description },
      label: { configurable: true, enumerable: true, writable: false, value: label },
      parameters: { configurable: true, enumerable: true, writable: false, value: parameters },
      execute: { configurable: true, enumerable: true, writable: false, value: execute },
    });
    if (prepareArguments) {
      Object.defineProperty(snapshot, "prepareArguments", {
        configurable: true,
        enumerable: true,
        writable: false,
        value: prepareArguments,
      });
    }
    if (executionMode) {
      Object.defineProperty(snapshot, "executionMode", {
        configurable: true,
        enumerable: true,
        writable: false,
        value: executionMode,
      });
    }
    return snapshot;
  } catch (error) {
    console.warn(
      `[agent-core] skipped invalid ${options.logContext} tool "${name}": ${describeAgentToolSnapshotError(error)}`,
    );
    return undefined;
  }
}

export function snapshotAgentTools<TTool extends AgentTool>(
  tools: TTool[] | undefined,
  options: SnapshotAgentToolsOptions,
): TTool[] {
  const snapshots: TTool[] = [];
  for (const [index, tool] of (tools ?? []).entries()) {
    const snapshot = snapshotAgentTool(tool, index, options);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}
