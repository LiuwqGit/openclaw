// Line plugin module implements conversation route resolution.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

/**
 * Resolves the LINE conversation route: configured ACP bindings first, then runtime
 * conversation bindings. Passing the configured result into the runtime resolver keeps
 * LINE ingress on the same precedence as the Gateway generic ownership evaluator.
 */
export function resolveLineConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  peerId: string;
  isGroup: boolean;
}): {
  route: ReturnType<typeof resolveAgentRoute>;
  configuredBinding: ReturnType<typeof resolveConfiguredBindingRoute>["bindingResolution"];
  configuredBindingSessionKey: string;
} {
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "line",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.peerId,
    },
  });

  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation: {
      channel: "line",
      accountId: params.accountId,
      conversationId: params.peerId,
    },
  });
  let configuredBinding = configuredRoute.bindingResolution;
  const configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
  route = configuredRoute.route;

  const runtimeRoute = resolveRuntimeConversationBindingRoute({
    route,
    configuredBindingRoute: configuredRoute,
    conversation: {
      channel: "line",
      accountId: params.accountId,
      conversationId: params.peerId,
    },
  });
  route = runtimeRoute.route;
  if (runtimeRoute.bindingRecord) {
    configuredBinding = null;
    logVerbose(
      runtimeRoute.boundSessionKey
        ? `line: routed via bound conversation ${params.peerId} -> ${runtimeRoute.boundSessionKey}`
        : `line: plugin-bound conversation ${params.peerId}`,
    );
  }

  return { route, configuredBinding, configuredBindingSessionKey };
}
