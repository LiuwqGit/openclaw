// Telegram plugin module tracks early callback-query acknowledgements:
// per-context answer promises for the bot pipeline, and the bot-scoped registry
// of admission-time acknowledgements issued by the durable ingress spool.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE = Symbol.for(
  "openclaw.telegram.callbackQueryAnswerPromise",
);

const TELEGRAM_CALLBACK_QUERY_ADMISSION_ACKS = Symbol.for(
  "openclaw.telegram.callbackQueryAdmissionAcks",
);

// One in-flight/settled acknowledgement promise per press is enough; the cap
// bounds the registry when a chat spams buttons faster than lanes drain.
const MAX_TRACKED_ADMISSION_ACKS = 512;

export function setTelegramCallbackQueryAnswerPromise(
  ctx: object,
  promise: Promise<unknown>,
): void {
  Object.defineProperty(ctx, TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE, {
    configurable: true,
    value: promise,
  });
}

export function getTelegramCallbackQueryAnswerPromise(ctx: object): Promise<unknown> | undefined {
  const promise = (ctx as Record<PropertyKey, unknown>)[TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE];
  return promise instanceof Promise ? promise : undefined;
}

function getTelegramCallbackQueryAdmissionAckStore(
  bot: object,
): Map<string, Promise<unknown>> | undefined {
  const store = (bot as Record<PropertyKey, unknown>)[TELEGRAM_CALLBACK_QUERY_ADMISSION_ACKS];
  return store instanceof Map ? store : undefined;
}

/**
 * Record the admission-time answerCallbackQuery promise for a callback query on
 * the bot that owns its durable ingress spool, so the drain-time replay can
 * reuse the acknowledgement instead of issuing a second bare answer.
 */
export function recordTelegramCallbackQueryAdmissionAck(
  bot: object,
  callbackQueryId: string,
  answerPromise: Promise<unknown>,
): void {
  let store = getTelegramCallbackQueryAdmissionAckStore(bot);
  if (!store) {
    store = new Map<string, Promise<unknown>>();
    Object.defineProperty(bot, TELEGRAM_CALLBACK_QUERY_ADMISSION_ACKS, {
      configurable: true,
      value: store,
    });
  }
  if (store.size >= MAX_TRACKED_ADMISSION_ACKS) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      store.delete(oldest);
    }
  }
  store.set(callbackQueryId, answerPromise);
}

/**
 * Look up the admission-time acknowledgement recorded for a callback query.
 * Returns undefined after a process restart or registry eviction; callers fall
 * back to answering live, which fails harmlessly once the query expired.
 */
export function getTelegramCallbackQueryAdmissionAck(
  bot: object,
  callbackQueryId: string,
): Promise<unknown> | undefined {
  return getTelegramCallbackQueryAdmissionAckStore(bot)?.get(callbackQueryId);
}

function resolveTelegramAdmittedCallbackQueryId(update: unknown): string | undefined {
  const callbackQueryId = (update as { callback_query?: { id?: unknown } } | null | undefined)
    ?.callback_query?.id;
  return typeof callbackQueryId === "string" && callbackQueryId.length > 0
    ? callbackQueryId
    : undefined;
}

/**
 * Answer a callback query at durable-admission time, before per-chat lane
 * blocking can delay the acknowledgement past Telegram's ~15s
 * answerCallbackQuery window. The acknowledgement carries no handler result,
 * so nothing about the outcome needs to be known to send it; outcome feedback
 * belongs to the chat surface. Fire-and-forget: a failure here must never fail
 * the spool write (the drain-time middleware still answers live as a fallback).
 * A webhook redelivery maps to the same spool row, so an already-acknowledged
 * query is skipped.
 */
export function acknowledgeTelegramAdmittedCallbackQuery(
  bot: object,
  update: unknown,
  params: {
    answer: (callbackQueryId: string) => Promise<unknown>;
    isNew: boolean;
    onLog?: (message: string) => void;
  },
): void {
  try {
    const callbackQueryId = resolveTelegramAdmittedCallbackQueryId(update);
    if (!callbackQueryId) {
      return;
    }
    if (!params.isNew && getTelegramCallbackQueryAdmissionAck(bot, callbackQueryId)) {
      return;
    }
    const answerPromise = params.answer(callbackQueryId);
    recordTelegramCallbackQueryAdmissionAck(bot, callbackQueryId, answerPromise);
    void answerPromise.catch((error: unknown) => {
      // The drain-time replay re-answers live when this promise rejects, so this
      // log records the failure without masking it.
      params.onLog?.(
        `telegram: admission answerCallbackQuery failed for callback query ${callbackQueryId}: ${formatErrorMessage(error)}`,
      );
    });
  } catch (error) {
    params.onLog?.(
      `telegram: admission answerCallbackQuery setup failed: ${formatErrorMessage(error)}`,
    );
  }
}
