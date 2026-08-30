// Telegram plugin module builds transport-shared durable ingress monitors.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramBotInfo } from "./bot-info.js";
import {
  runWithTelegramUpdateProcessingFrame,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { acknowledgeTelegramAdmittedCallbackQuery } from "./callback-query-answer-state.js";
import {
  createTelegramIngressMonitor,
  resolveTelegramAdoptionStallTimeoutMs,
  type TelegramIngressDrainLifecycle,
} from "./telegram-ingress-drain.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";

type TelegramSpooledBot = {
  handleUpdate: (update: never) => Promise<void>;
  api?: {
    answerCallbackQuery: (callbackQueryId: string) => Promise<unknown>;
  };
};

type CreateTelegramTransportIngressMonitorParams = {
  spoolDir: string;
  bot: TelegramSpooledBot;
  cfg: OpenClawConfig;
  accountId: string;
  botInfo?: TelegramBotInfo;
  adoptionStallTimeoutMs?: number;
  pollIntervalMs?: number;
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
  abortSignal?: AbortSignal;
  /**
   * Optional override for admission-time callback-query acknowledgement (tests).
   * Default: bot.api.answerCallbackQuery, so both transports answer a press as
   * soon as its update is durably spooled instead of when its chat lane drains.
   */
  answerCallbackQuery?: (callbackQueryId: string) => Promise<unknown>;
  /**
   * Optional override for full dispatch (tests). Default: bot.handleUpdate under
   * the drain lifecycle via bot-message spooled replay path.
   */
  dispatchUpdate?: (
    update: unknown,
    lifecycle: TelegramIngressDrainLifecycle,
  ) => Promise<TelegramMessageProcessingResult | void>;
};

/**
 * One monitor for polling + webhook: channel-owned append, shared claim →
 * dispatch with turnAdoptionLifecycle → complete at adoption.
 */
export function createTelegramTransportIngressMonitor(
  params: CreateTelegramTransportIngressMonitorParams,
) {
  const queue = openTelegramIngressQueue(params.spoolDir);
  const adoptionStallTimeoutMs = resolveTelegramAdoptionStallTimeoutMs({
    configured: params.adoptionStallTimeoutMs,
    env: process.env,
  });
  const botApi = params.bot.api;
  const answerSpooledCallbackQuery =
    params.answerCallbackQuery ??
    (botApi ? (callbackQueryId: string) => botApi.answerCallbackQuery(callbackQueryId) : undefined);
  return createTelegramIngressMonitor({
    queue,
    cfg: params.cfg,
    accountId: params.accountId,
    botInfo: params.botInfo,
    adoptionStallTimeoutMs,
    ...(params.pollIntervalMs === undefined ? {} : { pollIntervalMs: params.pollIntervalMs }),
    ...(params.onLog ? { onLog: params.onLog } : {}),
    ...(params.onError ? { onError: params.onError } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...(answerSpooledCallbackQuery
      ? {
          onDurableAdmission: (update: unknown, context: { isNew: boolean }) =>
            acknowledgeTelegramAdmittedCallbackQuery(params.bot, update, {
              answer: answerSpooledCallbackQuery,
              isNew: context.isNew,
              ...(params.onLog ? { onLog: params.onLog } : {}),
            }),
        }
      : {}),
    dispatch: async (update, lifecycle) => {
      if (params.dispatchUpdate) {
        return await params.dispatchUpdate(update, lifecycle);
      }
      // grammY returns void, so carry its middleware-owned outcome back to durable ingress.
      // The spooled lifecycle remains on its existing frame for complete-at-adoption.
      const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
        await params.bot.handleUpdate(update as never);
      });
      return result;
    },
  });
}
