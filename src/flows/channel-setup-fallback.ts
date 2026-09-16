// Channel setup fallback helpers for the empty-discovery-buckets recovery path.
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { getTrustedChannelPluginCatalogEntry } from "../commands/channel-setup/trusted-catalog.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Shows the standard "enable it before setup" note for disabled-policy guards. */
export async function noteDisabledBeforeSetup(
  prompter: Pick<WizardPrompter, "note">,
  channel: ChannelChoice,
  hint: string,
): Promise<void> {
  await prompter.note(
    t("wizard.channels.disabledBeforeSetup", { channel, hint }),
    t("wizard.channels.setupTitle"),
  );
}

/**
 * Resolves the trusted catalog entry for the setup fallback path.
 *
 * Callers reach this only when neither discovery bucket yielded an entry for
 * the channel, which can happen when `channels.<id>` in user config carries
 * stale fields left over from a previous install. Consulting the catalog
 * directly keeps externalized channels (qqbot, imessage, discord, whatsapp,
 * ...) on the auto-install path instead of a dead-end "plugin not available"
 * note.
 *
 * Callers MUST first check whether the channel's plugin is already loaded in
 * this process and skip the fallback when it is: discovery also excludes
 * loaded plugins from both buckets, so an empty pair does not by itself mean
 * the plugin is missing. Driving a catalog reinstall for a loaded plugin
 * rewrites `plugins.installs.<id>.installPath` and restarts the gateway under
 * the setup flow that asked for the install (#149672: Control UI SMS setup
 * looped on "install" forever).
 */
export function resolveSetupFallbackCatalogEntry(
  channel: ChannelChoice,
  cfg: OpenClawConfig,
  workspaceDir: string,
): ChannelPluginCatalogEntry | undefined {
  return getTrustedChannelPluginCatalogEntry(channel, { cfg, workspaceDir });
}
