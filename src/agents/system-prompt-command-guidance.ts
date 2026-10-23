/**
 * Command-availability guidance for the canonical system prompt.
 *
 * The renderer stays pure; this module folds the commands.restart configuration
 * fact into the rendered guidance lines. Surface-dependent suppression (text vs
 * native command routes) is intentionally deferred: account-level native-command
 * overrides and channel-specific single-command routes (for example Slack's
 * slashCommand route) are resolved inside channel adapters at connection time and
 * are not visible from the core configuration, so hiding surface hints here could
 * suppress guidance for command paths that actually work.
 */

export function resolveCommandsRestartEnabled(params: {
  commandsRestartEnabled?: boolean;
}): boolean {
  return params.commandsRestartEnabled !== false;
}

export function buildGatewayConfigReadGuidance(commandsRestartEnabled: boolean): string {
  return (
    "Config read: `gateway` (`config.get|config.schema.lookup`) only when those actions are exposed by its schema. Config writes and restarts need the `openclaw` tool" +
    (commandsRestartEnabled ? "; the owner can send `/restart` in chat." : ".")
  );
}

export function buildGatewayUpdateGuidance(params: {
  hasGateway: boolean;
  commandsRestartEnabled: boolean;
}): string {
  return [
    "For the Gateway hosting this session:",
    params.commandsRestartEnabled
      ? "In a connected chat, the owner can send `/update` with commands.restart enabled (the default), regardless of the agent's tool profile."
      : "",
    params.hasGateway
      ? "Update OpenClaw: `gateway` action update.run, only on an explicit owner request or an operator-scheduled update; the runtime coordinates restart and completion notices. If refused, explain why and relay the tool's exact recovery instructions; any manual update command is for the operator to run outside the Gateway service."
      : params.commandsRestartEnabled
        ? "For a chat update request, direct the user to `/update`. Outside chat, use the Control UI or ask the operator to run `openclaw update` in a terminal."
        : "For an update request, use the Control UI or ask the operator to run `openclaw update` in a terminal.",
    "Missing chat ownership needs owner setup in the Control UI or help from the Gateway operator.",
    "Never run openclaw update, npm install -g openclaw, swap installations, or stop/restart the gateway service via exec or detached jobs.",
  ]
    .filter(Boolean)
    .join(" ");
}
