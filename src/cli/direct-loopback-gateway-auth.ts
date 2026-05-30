import { loadConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { isLoopbackHost } from "../gateway/net.js";
import { normalizeStringifiedOptionalString } from "../shared/string-coerce.js";

export type DirectLoopbackGatewayAuthOpts = {
  url?: string;
  token?: string;
  password?: string;
  config?: OpenClawConfig;
};

type SharedGatewayCredentials = {
  token?: string;
  password?: string;
};

async function resolveConfiguredSharedGatewayCredentials(
  config: OpenClawConfig | undefined,
): Promise<SharedGatewayCredentials | undefined> {
  const resolvedConfig = config ?? loadConfigForDirectAuthProbe();
  const auth = resolveGatewayAuth({
    authConfig: resolvedConfig?.gateway?.auth,
    tailscaleMode: resolvedConfig?.gateway?.tailscale?.mode,
    env: process.env,
  });
  if (auth.mode !== "token" && auth.mode !== "password") {
    return undefined;
  }
  const literalCredentials = { token: auth.token, password: auth.password };
  if (literalCredentials.token || literalCredentials.password || !resolvedConfig) {
    return literalCredentials;
  }
  try {
    return await resolveGatewayConnectionAuth({
      config: resolvedConfig,
      env: process.env,
    });
  } catch {
    return undefined;
  }
}

async function isConfiguredSharedGatewayToken(params: {
  token: string | undefined;
  config?: OpenClawConfig;
}): Promise<boolean> {
  if (!params.token) {
    return false;
  }
  const credentials = await resolveConfiguredSharedGatewayCredentials(params.config);
  return credentials?.token === params.token;
}

function loadConfigForDirectAuthProbe(): OpenClawConfig | undefined {
  try {
    return loadConfig({ skipPluginValidation: true, pin: false });
  } catch {
    return undefined;
  }
}

function isLoopbackGatewayUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function resolveGatewayUrlForDirectAuth(opts: DirectLoopbackGatewayAuthOpts): string | undefined {
  const explicitUrl = normalizeStringifiedOptionalString(opts.url);
  if (explicitUrl) {
    return explicitUrl;
  }
  try {
    return buildGatewayConnectionDetails({ config: opts.config }).url;
  } catch {
    return undefined;
  }
}

export async function shouldUseDirectLoopbackGatewayAuth(
  opts: DirectLoopbackGatewayAuthOpts,
): Promise<boolean> {
  const token = normalizeStringifiedOptionalString(opts.token);
  const password = normalizeStringifiedOptionalString(opts.password);
  const explicitUrl = normalizeStringifiedOptionalString(opts.url);
  if (explicitUrl && !isLoopbackGatewayUrl(explicitUrl)) {
    return false;
  }
  const configuredCredentials =
    !token && !password ? await resolveConfiguredSharedGatewayCredentials(opts.config) : undefined;
  if (!token && !password && !configuredCredentials?.token && !configuredCredentials?.password) {
    return false;
  }
  const gatewayUrl = resolveGatewayUrlForDirectAuth(opts);
  if (!isLoopbackGatewayUrl(gatewayUrl)) {
    return false;
  }
  if (!token && !password) {
    return true;
  }
  return Boolean(
    password || (await isConfiguredSharedGatewayToken({ token, config: opts.config })),
  );
}
