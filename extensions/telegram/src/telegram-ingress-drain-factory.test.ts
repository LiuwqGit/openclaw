/** Verifies the grammY-to-durable-ingress terminal outcome handoff. */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureTelegramMessageProcessingResult,
  recordTelegramMessageProcessingResult,
  runWithTelegramUpdateProcessingFrame,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type { TelegramIngressDrainLifecycle } from "./telegram-ingress-drain.js";

const mocks = vi.hoisted(() => ({
  createTelegramIngressMonitor: vi.fn((params: unknown) => params),
  openTelegramIngressQueue: vi.fn(() => ({ kind: "test-queue" })),
  resolveTelegramAdoptionStallTimeoutMs: vi.fn(() => 5_000),
}));

vi.mock("./telegram-ingress-drain.js", () => ({
  createTelegramIngressMonitor: mocks.createTelegramIngressMonitor,
  resolveTelegramAdoptionStallTimeoutMs: mocks.resolveTelegramAdoptionStallTimeoutMs,
}));

vi.mock("./telegram-ingress-spool.js", () => ({
  openTelegramIngressQueue: mocks.openTelegramIngressQueue,
}));

const { createTelegramTransportIngressMonitor } =
  await import("./telegram-ingress-drain-factory.js");

type CapturedMonitor = {
  dispatch: (
    update: unknown,
    lifecycle: TelegramIngressDrainLifecycle,
  ) => Promise<TelegramMessageProcessingResult | void>;
  onDurableAdmission?: (update: unknown, context: { isNew: boolean }) => void | Promise<void>;
};

describe("Telegram transport ingress outcome handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { kind: "completed" as const },
    { kind: "skipped" as const },
    { kind: "failed-retryable" as const, error: new Error("retry the update") },
  ])(
    "returns the middleware-owned $kind outcome despite grammY returning void",
    async (outcome) => {
      const bot = {
        handleUpdate: vi.fn(async () => {
          await runWithTelegramUpdateProcessingFrame(async () => {
            recordTelegramMessageProcessingResult(outcome);
          });
        }),
      };
      createTelegramTransportIngressMonitor({
        spoolDir: "/tmp/telegram-ingress-proof",
        bot,
        cfg: {} as OpenClawConfig,
        accountId: "default",
      });
      const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;
      const update = { update_id: 123 };

      await expect(monitor.dispatch(update, {} as TelegramIngressDrainLifecycle)).resolves.toBe(
        outcome,
      );
      expect(bot.handleUpdate).toHaveBeenCalledWith(update);
    },
  );

  it("does not invent an outcome for deferred participant ownership", async () => {
    const bot = {
      handleUpdate: vi.fn(async () => {
        await runWithTelegramUpdateProcessingFrame(async () => {});
      }),
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });
    const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;

    await expect(
      monitor.dispatch({ update_id: 124 }, {} as TelegramIngressDrainLifecycle),
    ).resolves.toBeUndefined();
  });

  it("keeps an existing explicit skip when middleware applies its completion default", async () => {
    const bot = {
      handleUpdate: vi.fn(async () => {
        await runWithTelegramUpdateProcessingFrame(async () => {
          recordTelegramMessageProcessingResult({ kind: "skipped" });
          ensureTelegramMessageProcessingResult({ kind: "completed" });
        });
      }),
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });
    const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;

    await expect(
      monitor.dispatch({ update_id: 125 }, {} as TelegramIngressDrainLifecycle),
    ).resolves.toEqual({ kind: "skipped" });
  });

  it("answers a callback query once at durable admission and skips webhook redeliveries", () => {
    const answerCallbackQuery = vi.fn(async () => undefined);
    const bot = {
      handleUpdate: vi.fn(async () => undefined),
      api: { answerCallbackQuery },
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });
    const monitor = requireMonitor(mocks.createTelegramIngressMonitor.mock.calls[0]?.[0]);
    expect(monitor.onDurableAdmission).toBeTypeOf("function");

    const callbackUpdate = {
      update_id: 201,
      callback_query: {
        id: "cbq-admission-1",
        data: "cmd:option_a",
        from: { id: 111, is_bot: false, first_name: "Ada" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 10,
        },
      },
    };
    void monitor.onDurableAdmission?.(callbackUpdate, { isNew: true });
    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuery).toHaveBeenCalledWith("cbq-admission-1");

    // Non-callback updates carry no acknowledgement side channel.
    void monitor.onDurableAdmission?.(
      { update_id: 202, message: { chat: { id: 1234 } } },
      { isNew: true },
    );
    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);

    // A webhook redelivery maps to the same spool row and was already answered.
    void monitor.onDurableAdmission?.(callbackUpdate, { isNew: false });
    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("logs but never fails admission when the admission acknowledgement rejects", () => {
    const answerCallbackQuery = vi.fn(async () => {
      throw new Error("query is too old");
    });
    const onLog = vi.fn();
    const bot = {
      handleUpdate: vi.fn(async () => undefined),
      api: { answerCallbackQuery },
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      cfg: {} as OpenClawConfig,
      accountId: "default",
      onLog,
    });
    const monitor = requireMonitor(mocks.createTelegramIngressMonitor.mock.calls[0]?.[0]);

    expect(
      () =>
        void monitor.onDurableAdmission?.(
          { update_id: 203, callback_query: { id: "cbq-admission-2" } },
          { isNew: true },
        ),
    ).not.toThrow();
    expect(answerCallbackQuery).toHaveBeenCalledWith("cbq-admission-2");
  });

  it("leaves admission acknowledgement off when the bot exposes no answer API", () => {
    const bot = {
      handleUpdate: vi.fn(async () => undefined),
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      cfg: {} as OpenClawConfig,
      accountId: "default",
    });
    const monitor = requireMonitor(mocks.createTelegramIngressMonitor.mock.calls[0]?.[0]);
    expect(monitor.onDurableAdmission).toBeUndefined();
  });
});

function requireMonitor(captured: unknown): CapturedMonitor {
  if (!captured || typeof captured !== "object") {
    throw new Error("Expected createTelegramIngressMonitor params to be captured.");
  }
  return captured as CapturedMonitor;
}
