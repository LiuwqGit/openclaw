import { homedir as readHomeDir } from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import {
  isCodexAppServerProxyLaunch,
  normalizeCodexAppServerArgs,
  readCodexAppServerConfigOptions,
} from "./launch-args.js";

const CODEX_APP_SERVER_HOME_DIRNAME = "codex-home";
const CODEX_EPHEMERAL_AUTH_STORE_OVERRIDE = 'cli_auth_credentials_store="ephemeral"';
const CODEX_THREAD_UNLOAD_DELAY_CONFIG_KEY = "thread_unload_delay_secs";
const CODEX_MANAGED_THREAD_UNLOAD_DELAY_OVERRIDE = "thread_unload_delay_secs=0";

export function resolveCodexAppServerHomeDir(agentDir: string | undefined): string {
  if (!agentDir) {
    throw new Error("Agent-scoped Codex requires an OpenClaw agent directory");
  }
  return path.join(path.resolve(agentDir), CODEX_APP_SERVER_HOME_DIRNAME);
}

/** Resolves the native user Codex home used by Desktop and the CLI. */
export function resolveCodexAppServerUserHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = readHomeDir,
): string {
  const configured = normalizeOptionalString(env.CODEX_HOME);
  return path.resolve(configured ?? path.join(homedir(), ".codex"));
}

/** Resolves the local CODEX_HOME used when starting one app-server connection. */
export function resolveCodexAppServerLocalHomeDir(
  startOptions: CodexAppServerStartOptions,
  agentDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (startOptions.codexHome) {
    return startOptions.codexHome;
  }
  const configured = startOptions.env?.CODEX_HOME;
  if (configured?.trim()) {
    return configured;
  }
  return startOptions.homeScope === "user"
    ? resolveCodexAppServerUserHomeDir(env)
    : resolveCodexAppServerHomeDir(agentDir);
}

/** Forces OpenClaw-owned Codex auth to remain process-local. */
export function withEphemeralCodexAuthStore(params: {
  startOptions: CodexAppServerStartOptions;
  preparedAuth?: unknown;
  authProfileId?: string | null;
}): CodexAppServerStartOptions {
  const { startOptions } = params;
  if (!params.preparedAuth && params.authProfileId === null) {
    return startOptions;
  }
  const args = normalizeCodexAppServerArgs(startOptions.args, CODEX_EPHEMERAL_AUTH_STORE_OVERRIDE);
  return args === startOptions.args ? startOptions : { ...startOptions, args };
}

function readConfiguredThreadUnloadDelay(args: readonly string[]): string | undefined {
  for (const option of readCodexAppServerConfigOptions(args)) {
    const value = option.value?.trim();
    if (!value?.includes("=")) {
      continue;
    }
    const [key, ...rest] = value.split("=");
    if (key.trim() === CODEX_THREAD_UNLOAD_DELAY_CONFIG_KEY) {
      return rest.join("=").trim();
    }
  }
  return undefined;
}

function isManagedLocalCodexAppServerStart(startOptions: CodexAppServerStartOptions): boolean {
  return (
    startOptions.transport === "stdio" &&
    startOptions.homeScope === "agent" &&
    (startOptions.commandSource === "managed" ||
      startOptions.commandSource === "resolved-managed") &&
    !isCodexAppServerProxyLaunch(startOptions.args)
  );
}

/** True when this managed local server unloads threads as soon as their last subscription is released. */
export function codexAppServerStartZeroUnloadDelay(
  startOptions: CodexAppServerStartOptions,
): boolean {
  return (
    isManagedLocalCodexAppServerStart(startOptions) &&
    readConfiguredThreadUnloadDelay(startOptions.args) === "0"
  );
}

/** Lets OpenClaw-owned local servers release a settled failed thread without retiring the shared client. */
export function withManagedCodexThreadUnloadDelay(
  startOptions: CodexAppServerStartOptions,
): CodexAppServerStartOptions {
  if (
    !isManagedLocalCodexAppServerStart(startOptions) ||
    readConfiguredThreadUnloadDelay(startOptions.args) !== undefined
  ) {
    return startOptions;
  }
  const args = normalizeCodexAppServerArgs(
    startOptions.args,
    CODEX_MANAGED_THREAD_UNLOAD_DELAY_OVERRIDE,
  );
  return args === startOptions.args ? startOptions : { ...startOptions, args };
}

export function withClearedEnvironmentVariables(
  startOptions: CodexAppServerStartOptions,
  envVars: readonly string[],
): CodexAppServerStartOptions {
  const clearEnv = startOptions.clearEnv ?? [];
  const missingEnvVars = envVars.filter((envVar) => !clearEnv.includes(envVar));
  if (missingEnvVars.length === 0) {
    return startOptions;
  }
  return {
    ...startOptions,
    clearEnv: [...clearEnv, ...missingEnvVars],
  };
}
