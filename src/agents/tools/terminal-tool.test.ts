import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { TERMINAL_OPEN_DEADLINE_MS } from "../../gateway/terminal/open-deadline.js";
import { TerminalSessionManager } from "../../gateway/terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
} from "../../gateway/terminal/session-manager.test-helpers.js";
import {
  shellReadyMarker,
  shellReadySentinel,
  TERMINAL_SHELL_READY_ENV,
} from "../../gateway/terminal/startup-handoff.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import type { spawnTerminalPty } from "../../process/terminal-pty.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createTerminalTool, type TerminalToolOptions } from "./terminal-tool.js";

const callInProcessGatewayTool = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const getInProcessGatewayToolContext = vi.hoisted(() => vi.fn());
const loadGatewaySessionEntryReadOnly = vi.hoisted(() => vi.fn(() => ({ entry: undefined })));
const approvalMocks = vi.hoisted(() => ({
  register: vi.fn(async ({ approvalId }: { approvalId: string }) => ({
    id: approvalId,
    expiresAtMs: Date.now() + 10_000,
  })),
  decide: vi.fn(async (): Promise<string | null> => "allow-once"),
}));

vi.mock("./in-process-gateway.js", () => ({
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
}));
vi.mock("../../gateway/session-utils-store.js", () => ({ loadGatewaySessionEntryReadOnly }));
vi.mock("../bash-tools.exec-approval-request.js", () => ({
  registerExecApprovalRequestForHostOrThrow: approvalMocks.register,
  resolveRegisteredExecApprovalDecision: approvalMocks.decide,
}));

type TerminalPtyHandle = Awaited<ReturnType<typeof spawnTerminalPty>>;

function makeBackend() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const backend: TerminalPtyHandle & {
    writes: string[];
    resizes: Array<[number, number]>;
    killed: boolean;
    env: Record<string, string>;
    emitData(data: string): void;
    emitExit(code: number): void;
  } = {
    pid: 4242,
    writes: [],
    resizes: [],
    killed: false,
    env: {},
    write: (data) => {
      backend.writes.push(data);
      // Simulate an interactive shell executing the readiness sentinel and
      // emitting the framed marker, so the shell-readiness handoff completes.
      if (data.includes(TERMINAL_SHELL_READY_ENV)) {
        const token = backend.env[TERMINAL_SHELL_READY_ENV];
        if (token !== undefined) {
          backend.emitData(`${shellReadyMarker(token)}\r\n`);
        }
      }
    },
    resize: (cols, rows) => backend.resizes.push([cols, rows]),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: () => {
      backend.killed = true;
    },
    onData: (listener) => {
      onData = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
    emitData: (data) => onData?.(data),
    emitExit: (code) => onExit?.({ exitCode: code }),
  };
  return backend;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function makeContext(manager: TerminalSessionManager) {
  return {
    terminalSessions: manager,
    isTerminalEnabled: () => true,
    resolveTerminalLaunchPolicy: () => ({
      ok: true as const,
      plan: {
        agentId: "main",
        cwd: "/tmp",
        shell: "/bin/sh",
        args: [],
      },
    }),
  };
}

// === Input authorization test infrastructure ===
// Proves the input action goes through the current-main execution-policy,
// approval, and delegated-authority chain (ClawSweeper P1 requirement).
const sharedOwner = agentTerminalOwner("agent:main:main", "main-session-id");

function makeSharedContext(manager: TerminalSessionManager) {
  return {
    terminalSessions: manager,
    isTerminalEnabled: () => true,
    resolveTerminalLaunchPolicy: () => ({
      ok: true as const,
      plan: { agentId: "main", cwd: "/tmp", shell: "/bin/sh", args: [] },
    }),
  } as unknown as GatewayRequestContext;
}

function makeSharedTool(
  manager: TerminalSessionManager,
  options: Partial<TerminalToolOptions> = {},
) {
  return createTerminalTool({
    agentId: "main",
    agentSessionKey: sharedOwner.agentSessionKey,
    sessionId: sharedOwner.agentSessionId,
    execSession: {},
    getGatewayContext: () => makeSharedContext(manager),
    ...options,
  });
}

async function openSharedTerminal() {
  const backend = makeBackend();
  const spawn = vi.fn(async () => backend);
  const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
  const opened = await manager.open(baseOpenRequest({ owner: sharedOwner }));
  if (!opened.ok) {
    throw new Error("expected operator-opened terminal");
  }
  spawn.mockClear();
  return { backend, manager, sessionId: opened.sessionId, spawn };
}

async function withActiveRun<T>(
  manager: TerminalSessionManager,
  run: (authority: ReturnType<typeof claimAgentRunDelegatedAuthority>) => Promise<T>,
) {
  const operationalRunInstance = { instanceId: "terminal-instance", runId: "terminal-run" };
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  try {
    return await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: sharedOwner.agentSessionKey,
        operationalRunInstance,
        gatewayContextResolver: () => makeSharedContext(manager) as GatewayRequestContext,
      },
      () => run(authority),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

describe("terminal tool", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
    callInProcessGatewayTool.mockClear();
    getInProcessGatewayToolContext.mockReset();
    loadGatewaySessionEntryReadOnly.mockClear();
    approvalMocks.register.mockClear();
    approvalMocks.decide.mockReset();
    approvalMocks.decide.mockResolvedValue("allow-once");
  });

  it("uses a flat action enum and the owner-only core gate", () => {
    const tool = createTerminalTool();
    expect(tool.description).toContain("Manage terminals");
    expect(tool.parameters).toMatchObject({
      properties: {
        action: {
          type: "string",
          enum: ["open", "read", "input", "resize", "close", "list"],
        },
      },
    });
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("show");
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("terminal");
  });

  it("uses the admitted caller Gateway before ambient context", async () => {
    const callerManager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const ambientManager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const callerList = vi.spyOn(callerManager, "listAgent");
    const ambientList = vi.spyOn(ambientManager, "listAgent");
    const gatewayContextResolver = vi.fn();
    gatewayContextResolver.mockReturnValue(makeContext(callerManager));
    getInProcessGatewayToolContext.mockReturnValue(makeContext(ambientManager));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
    });

    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        gatewayContextResolver,
      },
      async () => await tool.execute("list", { action: "list" }),
    );

    expect(result.details).toEqual({ sessions: [] });
    expect(callerList).toHaveBeenCalledOnce();
    expect(ambientList).not.toHaveBeenCalled();
  });

  it("fails closed when the admitted caller Gateway has retired", async () => {
    const ambientManager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const ambientList = vi.spyOn(ambientManager, "listAgent");
    getInProcessGatewayToolContext.mockReturnValue(makeContext(ambientManager));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
    });

    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => undefined,
        },
        async () => await tool.execute("list", { action: "list" }),
      ),
    ).rejects.toThrow("terminal unavailable");
    expect(ambientList).not.toHaveBeenCalled();
  });

  it("revalidates the admitted Gateway after task lookup before opening", async () => {
    const callerSpawn = vi.fn(async () => makeBackend());
    const ambientSpawn = vi.fn(async () => makeBackend());
    const callerManager = new TerminalSessionManager({ emit: vi.fn(), spawn: callerSpawn });
    const ambientManager = new TerminalSessionManager({ emit: vi.fn(), spawn: ambientSpawn });
    let callerLive = true;
    const gatewayContextResolver = vi.fn();
    gatewayContextResolver.mockImplementation(() =>
      callerLive ? makeContext(callerManager) : undefined,
    );
    getInProcessGatewayToolContext.mockReturnValue(makeContext(ambientManager));
    const lookupTaskByRunIdForChildSession = vi.fn(async () => {
      callerLive = false;
      return undefined;
    });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      runId: "run-1",
      lookupTaskByRunIdForChildSession,
    });

    await expect(
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver,
        },
        async () => await tool.execute("open", { action: "open" }),
      ),
    ).rejects.toThrow("terminal unavailable");
    expect(gatewayContextResolver).toHaveBeenCalledTimes(2);
    expect(callerSpawn).not.toHaveBeenCalled();
    expect(ambientSpawn).not.toHaveBeenCalled();
    expect(getInProcessGatewayToolContext).not.toHaveBeenCalled();
  });

  it("closes a terminal when the admitted Gateway retires during open", async () => {
    const spawned = deferred<ReturnType<typeof makeBackend>>();
    const backend = makeBackend();
    const callerSpawn = vi.fn(() => spawned.promise);
    const callerManager = new TerminalSessionManager({ emit: vi.fn(), spawn: callerSpawn });
    const ambientSpawn = vi.fn(async () => makeBackend());
    const ambientManager = new TerminalSessionManager({ emit: vi.fn(), spawn: ambientSpawn });
    let callerLive = true;
    const gatewayContextResolver = vi.fn();
    gatewayContextResolver.mockImplementation(() =>
      callerLive ? makeContext(callerManager) : undefined,
    );
    getInProcessGatewayToolContext.mockReturnValue(makeContext(ambientManager));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
    });

    const opening = withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        gatewayContextResolver,
      },
      async () => await tool.execute("open", { action: "open", command: "echo unsafe" }),
    );
    await vi.waitFor(() => expect(callerSpawn).toHaveBeenCalledOnce());
    callerLive = false;
    spawned.resolve(backend);

    await expect(opening).rejects.toThrow("terminal unavailable");
    expect(gatewayContextResolver).toHaveBeenCalledTimes(2);
    expect(backend.writes).toEqual([]);
    expect(backend.killed).toBe(true);
    expect(callerManager.size).toBe(0);
    expect(ambientSpawn).not.toHaveBeenCalled();
    expect(getInProcessGatewayToolContext).not.toHaveBeenCalled();
  });

  it("keeps ambient Gateway context pinned across task lookup", async () => {
    const firstSpawn = vi.fn(async () => makeBackend());
    const secondSpawn = vi.fn(async () => makeBackend());
    const firstManager = new TerminalSessionManager({ emit: vi.fn(), spawn: firstSpawn });
    const secondManager = new TerminalSessionManager({ emit: vi.fn(), spawn: secondSpawn });
    getInProcessGatewayToolContext
      .mockReturnValueOnce(makeContext(firstManager))
      .mockReturnValue(makeContext(secondManager));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      runId: "run-1",
      lookupTaskByRunIdForChildSession: vi.fn(async () => undefined),
    });

    await expect(tool.execute("open", { action: "open" })).resolves.toMatchObject({
      details: { ok: true },
    });
    expect(getInProcessGatewayToolContext).toHaveBeenCalledOnce();
    expect(firstSpawn).toHaveBeenCalledOnce();
    expect(secondSpawn).not.toHaveBeenCalled();
  });

  it("uses ambient Gateway context without an admitted caller", async () => {
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const list = vi.spyOn(manager, "listAgent");
    getInProcessGatewayToolContext.mockReturnValue(makeContext(manager));
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
    });

    await expect(tool.execute("list", { action: "list" })).resolves.toMatchObject({
      details: { sessions: [] },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it("opens in the background, reads, writes, resizes, lists, and closes its terminal", async () => {
    const backend = makeBackend();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async (params) => {
        backend.env = params.env;
        return backend;
      },
    });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => makeContext(manager),
    });
    expect(tool.outputSchema).toBeDefined();
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ sessions: Array<{ agentId: string; attached: boolean; createdAtMs: number; cwd: string; owner: string; sessionId: string; shell: string }> } | { agentId: string; cwd: string; ok: true; sessionId: string; shell: string } | { sessionId: string; text: string } | { ok: true }",
    );

    const opened = await tool.execute("open", { action: "open", command: "echo ready" });
    expect(Value.Check(tool.outputSchema!, opened.details)).toBe(true);
    const sessionId = (opened.details as { sessionId: string }).sessionId;
    // The initial command is delivered only after the shell-readiness sentinel
    // echoes the per-open secret, so a long command cannot be mangled before
    // the login shell reaches its read loop.
    const readyToken = backend.env[TERMINAL_SHELL_READY_ENV];
    expect(backend.writes).toEqual([shellReadySentinel("/bin/sh")!, "echo ready\r"]);
    expect(callInProcessGatewayTool).not.toHaveBeenCalled();

    backend.emitData("\u001b[31mready\u001b[0m\r\n");
    const read = await tool.execute("read", { action: "read", sessionId });
    expect(read.details).toEqual({
      sessionId,
      text: `${shellReadyMarker(readyToken!)}\nready\n`,
    });
    expect(Value.Check(tool.outputSchema!, read.details)).toBe(true);

    // Input requires the full exec-policy/approval chain (tested separately);
    // verify only that writeAgent accepts data when called via the manager.
    expect(
      manager.writeAgent(
        {
          kind: "agent",
          agentSessionKey: "agent:main:main",
          agentSessionId: "main-session-id",
          agentId: "main",
        },
        sessionId,
        "yes\r",
      ).ok,
    ).toBe(true);
    expect(backend.writes).toEqual([shellReadySentinel("/bin/sh"), "echo ready\r", "yes\r"]);
    const resize = await tool.execute("resize", {
      action: "resize",
      sessionId,
      cols: 120,
      rows: 40,
    });
    expect(resize.details).toEqual({ ok: true });
    expect(Value.Check(tool.outputSchema!, resize.details)).toBe(true);
    expect(backend.resizes).toEqual([[120, 40]]);

    const list = await tool.execute("list", { action: "list" });
    expect(list.details).toEqual({
      sessions: [
        expect.objectContaining({
          sessionId,
          owner: "agent:agent:main:main",
        }),
      ],
    });
    expect(Value.Check(tool.outputSchema!, list.details)).toBe(true);
    const closed = await tool.execute("close", { action: "close", sessionId });
    expect(closed.details).toEqual({ ok: true });
    expect(Value.Check(tool.outputSchema!, closed.details)).toBe(true);
    expect(backend.killed).toBe(true);
  });

  it("preserves the immediate-write path for an unsupported configured shell", async () => {
    const backend = makeBackend();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async (params) => {
        backend.env = params.env;
        return backend;
      },
    });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => ({
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        resolveTerminalLaunchPolicy: () => ({
          ok: true as const,
          plan: { agentId: "main", cwd: "/tmp", shell: "/usr/bin/nu", args: [] },
        }),
      }),
    });

    const opened = await tool.execute("open", { action: "open", command: "echo ready" });
    // No readiness sentinel is written for an unsupported shell; the prior
    // immediate-write behavior is preserved so the command is delivered once.
    expect(backend.writes).toEqual(["echo ready\r"]);
    const sessionId = (opened.details as { sessionId: string }).sessionId;
    backend.emitData("ready\r\n");
    const read = await tool.execute("read", { action: "read", sessionId });
    expect(read.details).toEqual({ sessionId, text: "ready\n" });
  });

  it("refuses an open when its exact task is already terminal", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:completed-task",
      sessionId: "completed-session-id",
      runId: "completed-run",
      lookupTaskByRunIdForChildSession: vi.fn(async () => ({
        taskId: "task-completed",
        status: "succeeded" as const,
        childSessionKey: "agent:main:completed-task",
      })),
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "terminal task already ended",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("fails closed when launch policy blocks the agent", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => ({
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        resolveTerminalLaunchPolicy: () => ({
          ok: false,
          block: { kind: "sandboxed", agentId: "main", mode: "all" },
        }),
      }),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "terminal unavailable: agent sandboxed (all)",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves an explicit-owner launch failure", async () => {
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: vi.fn() });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => ({
        terminalSessions: manager,
        isTerminalEnabled: () => true,
        resolveTerminalLaunchPolicy: () => ({
          ok: false,
          block: { kind: "owner-required", message: "select an agent explicitly" },
        }),
      }),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow(
      "select an agent explicitly",
    );
  });

  it("does not open while the terminal surface is disabled", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => ({
        ...makeContext(manager),
        isTerminalEnabled: () => false,
      }),
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow("terminal disabled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("validates open arguments before allocating a terminal", async () => {
    const spawn = vi.fn(async () => makeBackend());
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn });
    const tool = createTerminalTool({
      agentId: "main",
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => makeContext(manager),
    });

    await expect(tool.execute("open", { action: "open", command: 42 })).rejects.toThrow(
      "command must be string",
    );
    await expect(tool.execute("open", { action: "open", cwd: 42 })).rejects.toThrow(
      "cwd must be string",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it("bounds terminal creation and kills a backend that arrives after timeout", async () => {
    vi.useFakeTimers();
    try {
      const spawned = deferred<ReturnType<typeof makeBackend>>();
      const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: () => spawned.promise });
      const tool = createTerminalTool({
        agentId: "main",
        agentSessionKey: "agent:main:main",
        sessionId: "main-session-id",
        getGatewayContext: () => makeContext(manager),
      });
      const opening = tool.execute("open", { action: "open" });
      const timedOut = expect(opening).rejects.toThrow("terminal open timed out");

      await vi.advanceTimersByTimeAsync(TERMINAL_OPEN_DEADLINE_MS);
      await timedOut;

      const backend = makeBackend();
      spawned.resolve(backend);
      await vi.waitFor(() => expect(backend.killed).toBe(true));
      expect(manager.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot list or operate connection-owned and replacement-incarnation terminals", async () => {
    const connBackend = makeBackend();
    const otherBackend = makeBackend();
    const backends = [connBackend, otherBackend];
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => backends.shift() ?? makeBackend(),
    });
    const conn = await manager.open({
      owner: { kind: "conn", connId: "operator" },
      agentId: "main",
      cwd: "/tmp",
      shell: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
      env: {},
    });
    const other = await manager.open({
      owner: {
        kind: "agent",
        agentSessionKey: "agent:main:main",
        agentSessionId: "replacement-session-id",
        agentId: "main",
      },
      agentId: "main",
      cwd: "/tmp",
      shell: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
      env: {},
    });
    if (!conn.ok || !other.ok) {
      throw new Error("expected opens");
    }
    const tool = createTerminalTool({
      agentSessionKey: "agent:main:main",
      sessionId: "main-session-id",
      getGatewayContext: () => makeContext(manager),
    });

    for (const sessionId of [conn.sessionId, other.sessionId]) {
      await expect(tool.execute("read", { action: "read", sessionId })).rejects.toThrow(
        "Terminal session unavailable. Use action=list to find an owned terminal or action=open to acquire one.",
      );
      await expect(
        tool.execute("input", { action: "input", sessionId, data: "blocked" }),
      ).rejects.toThrow(
        "Terminal session unavailable. Use action=list to find an owned terminal or action=open to acquire one.",
      );
      await expect(
        tool.execute("resize", { action: "resize", sessionId, cols: 120, rows: 40 }),
      ).rejects.toThrow(
        "Terminal session unavailable. Use action=list to find an owned terminal or action=open to acquire one.",
      );
      await expect(tool.execute("close", { action: "close", sessionId })).rejects.toThrow(
        "Terminal session unavailable. Use action=list to find an owned terminal or action=open to acquire one.",
      );
    }
    await expect(tool.execute("list", { action: "list" })).resolves.toMatchObject({
      details: { sessions: [] },
    });
    expect(connBackend.writes).toEqual([]);
    expect(otherBackend.writes).toEqual([]);
    expect(connBackend.killed).toBe(false);
    expect(otherBackend.killed).toBe(false);
  });

  it.each([
    {
      name: "initial command",
      configure: (backend: ReturnType<typeof makeBackend>) => {
        backend.write = () => {
          throw new Error("write failed");
        };
      },
      execute: (tool: ReturnType<typeof createTerminalTool>) =>
        tool.execute("open", { action: "open", command: "echo ready" }),
    },
    // Note: the 'input' action now routes through the current-main execution-policy
    // and approval chain, which validates the session and authority before reaching
    // writeAgent. A write-failure recovery test for input requires a full auth-chain
    // mock setup (covered in the dedicated input authorization tests below).
    {
      name: "resize",
      configure: (backend: ReturnType<typeof makeBackend>) => {
        backend.resize = () => {
          throw new Error("resize failed");
        };
      },
      execute: async (tool: ReturnType<typeof createTerminalTool>) => {
        const opened = await tool.execute("open", { action: "open" });
        const sessionId = (opened.details as { sessionId: string }).sessionId;
        return tool.execute("resize", { action: "resize", sessionId, cols: 120, rows: 40 });
      },
    },
  ])(
    "throws actionable recovery when backend $name fails",
    async ({ name, configure, execute }) => {
      const backend = makeBackend();
      configure(backend);
      const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => backend });
      const tool = createTerminalTool({
        agentId: "main",
        agentSessionKey: "agent:main:main",
        sessionId: "main-session-id",
        getGatewayContext: () => makeContext(manager),
      });

      await expect(execute(tool)).rejects.toThrow(
        `Terminal ${name} failed. Use action=list to find an owned terminal or action=open to acquire one.`,
      );
      expect(manager.size).toBe(0);
    },
  );

  // === Input authorization chain tests (current-main security boundary) ===
  // Proves that the 'input' action is gated by execution policy, active-run
  // authority, delegated-authority lifecycle, and operator approval — the
  // security boundary from PR #129604 preserved in this branch.

  it("rejects terminal input denied by execution policy without requesting approval", async () => {
    const { backend, manager, sessionId } = await openSharedTerminal();
    const tool = makeSharedTool(manager, {
      config: { tools: { exec: { mode: "deny" } } },
    });

    await expect(
      tool.execute("input", { action: "input", sessionId, data: "echo unsafe\r" }),
    ).rejects.toThrow("Terminal input denied by execution policy");

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it("rejects terminal input when the authoritative persisted session is missing", async () => {
    const { backend, manager, sessionId } = await openSharedTerminal();
    const tool = makeSharedTool(manager, { execSession: undefined });

    await expect(
      tool.execute("input", { action: "input", sessionId, data: "echo unsafe\r" }),
    ).rejects.toThrow("Terminal session unavailable");

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it("writes terminal input immediately under full exec policy with active run authority", async () => {
    const { backend, manager, sessionId } = await openSharedTerminal();
    const tool = makeSharedTool(manager, {
      config: { tools: { exec: { mode: "full" } } },
    });

    await withActiveRun(manager, async () => {
      const result = await tool.execute("input", {
        action: "input",
        sessionId,
        data: "echo approved\r",
      });
      expect(result.details).toEqual({ ok: true });
    });

    expect(backend.writes).toEqual(["echo approved\r"]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it("rejects full terminal input without an active admitted run", async () => {
    const { backend, manager, sessionId } = await openSharedTerminal();
    const tool = makeSharedTool(manager, {
      config: { tools: { exec: { mode: "full" } } },
    });

    await expect(
      tool.execute("input", { action: "input", sessionId, data: "echo unsafe\r" }),
    ).rejects.toThrow("agent run is no longer active");

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });

  it.each(["released", "replaced"] as const)(
    "rejects full terminal input after its exact run authority is %s",
    async (lifecycle) => {
      const { backend, manager, sessionId } = await openSharedTerminal();
      const tool = makeSharedTool(manager, {
        config: { tools: { exec: { mode: "full" } } },
      });

      await withActiveRun(manager, async (authority) => {
        const replacement =
          lifecycle === "replaced"
            ? claimAgentRunDelegatedAuthority({
                instanceId: "replacement-instance",
                runId: authority.operationalRunInstance.runId,
              })
            : undefined;
        if (!replacement) {
          releaseAgentRunDelegatedAuthority(authority);
        }

        try {
          await expect(
            tool.execute("input", { action: "input", sessionId, data: "echo stale\r" }),
          ).rejects.toThrow("agent run is no longer active");
        } finally {
          if (replacement) {
            releaseAgentRunDelegatedAuthority(replacement);
          }
        }
      });

      expect(backend.writes).toEqual([]);
    },
  );

  it("requires explicit operator approval for every input under non-full exec policy", async () => {
    const { backend, manager, sessionId } = await openSharedTerminal();
    const tool = makeSharedTool(manager, {
      execSession: { permissionMode: "guarded" },
      runId: "terminal-run",
      approvalReviewerDeviceIds: ["reviewer-device"],
    });

    await withActiveRun(manager, async () => {
      for (const [index, data] of ["echo first\r", "echo second\r"].entries()) {
        const result = await tool.execute(`input-${index}`, {
          action: "input",
          sessionId,
          data,
        });
        expect(result.details).toEqual({ ok: true });
      }
    });

    expect(backend.writes).toEqual(["echo first\r", "echo second\r"]);
    expect(approvalMocks.register).toHaveBeenCalledTimes(2);
    expect(approvalMocks.decide).toHaveBeenCalledTimes(2);
  });

  it("rejects guarded input when the operator decision is not allow-once", async () => {
    const { backend, manager, sessionId } = await openSharedTerminal();
    const tool = makeSharedTool(manager, {
      execSession: { permissionMode: "guarded" },
    });
    approvalMocks.decide.mockResolvedValueOnce("deny");

    await withActiveRun(manager, async () => {
      await expect(
        tool.execute("input", { action: "input", sessionId, data: "echo rejected\r" }),
      ).rejects.toThrow("operator approval required");
    });

    expect(backend.writes).toEqual([]);
  });

  it("rejects guarded input outside an active admitted agent run", async () => {
    const { backend, manager, sessionId } = await openSharedTerminal();
    const tool = makeSharedTool(manager, {
      execSession: { permissionMode: "guarded" },
    });

    await expect(
      tool.execute("input", { action: "input", sessionId, data: "echo unsafe\r" }),
    ).rejects.toThrow("agent run is no longer active");

    expect(backend.writes).toEqual([]);
    expect(approvalMocks.register).not.toHaveBeenCalled();
  });
});
