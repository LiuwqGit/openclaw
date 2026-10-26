import type { AgentPromptSurfaceKind } from "../plugins/types.js";
import { parseSkillsPromptCatalog } from "../skills/loading/skill-prompt-catalog.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "./tool-catalog.js";

export function buildSkillsSection(params: {
  skillsPrompt?: string;
  readToolName: string;
  codeModeActive?: boolean;
  installedSkillSearch?: boolean;
  installedSkillRead?: boolean;
  deferredSkillSearch?: boolean;
  deferredSkillRead?: boolean;
  skillsDispatcherToolName?: string;
}) {
  const trimmed = params.skillsPrompt?.trim();
  const hasListedSkills = parseSkillsPromptCatalog(trimmed ?? "").length > 0;
  const skillReadAvailable = params.installedSkillRead || params.deferredSkillRead;
  const skillSearchAvailable = params.installedSkillSearch || params.deferredSkillSearch;
  if (!hasListedSkills && !skillSearchAvailable) {
    return trimmed ? ["## Skills", trimmed, ""] : [];
  }
  // Deferred tools are not sent to the model directly; they run through the Tool
  // Search dispatcher. Without a visible dispatcher (schema directory mode),
  // deferred skill tools stay directly callable by name.
  const dispatcher = params.skillsDispatcherToolName;
  const readLine = params.codeModeActive
    ? skillReadAvailable
      ? 'Known name or clear match: use `skills.read("<name>")` inside `exec`; read the complete instructions before task actions and follow them.'
      : `Clear match: read exact <location> with \`${params.readToolName}\`; obey.`
    : params.installedSkillRead || (params.deferredSkillRead && !dispatcher)
      ? "Known name or clear match: use `skills_read` with its exact name; read the complete instructions before task actions and follow them."
      : params.deferredSkillRead && dispatcher
        ? `Known name or clear match: call \`${dispatcher}\` with \`skills_read\` in \`id\` and the exact skill name in \`args\`; read the complete instructions before task actions and follow them.`
        : `Clear match: read exact <location> with \`${params.readToolName}\`; obey.`;
  const searchClause = params.codeModeActive
    ? "with `skills.search(query)` inside `exec`"
    : params.installedSkillSearch || (params.deferredSkillSearch && !dispatcher)
      ? "with `skills_search`"
      : params.deferredSkillSearch && dispatcher
        ? `by calling \`${dispatcher}\` with \`skills_search\` in \`id\` and the query in \`args\``
        : "with `skills_search`";
  return [
    "## Skills",
    ...(hasListedSkills
      ? ["Scan <available_skills> for a matching workflow."]
      : ["No skill entries are listed in this prompt."]),
    readLine,
    ...(skillSearchAvailable
      ? [
          `Before work involving files, specialized tools, or a reusable workflow, ${hasListedSkills ? "use a listed match or search" : "search"} ${searchClause} for an applicable skill. Read the best match before implementing the workflow yourself.`,
          "Search by the task goal and distinctive terms. Simple conversation or a self-contained answer does not need a search. Search covers installed skills; it does not install skills.",
        ]
      : []),
    "Several: most specific. No relevant skill: read none.",
    "Up-front max one. Never invent paths.",
    "External writes: batch safely; no tight loops; honor 429/Retry-After.",
    ...(trimmed ? [trimmed] : []),
    "",
  ];
}

type ToolNameLookup = ReadonlySet<string> | ReadonlyMap<string, string>;

export function renderSkillsPromptSection(params: {
  skillsPrompt?: string;
  readToolName: string;
  codeModeActive?: boolean;
  promptSurface?: AgentPromptSurfaceKind;
  visibleToolNames: ToolNameLookup;
  capabilityToolNames: ToolNameLookup;
  deferredToolsDirectlyCallable?: boolean;
}): { section: string[]; canAccess: boolean } {
  // CLI backends own native file tools outside OpenClaw's projected tool list.
  // Keep their skill catalog visible while embedded runs require a real read tool.
  const canAccess = params.codeModeActive
    ? params.visibleToolNames.has("exec")
    : params.visibleToolNames.has("read") ||
      params.capabilityToolNames.has("skills_read") ||
      params.promptSurface === "cli_backend";
  const { visibleToolNames: visible, capabilityToolNames: available } = params;
  const dispatcher =
    !params.deferredToolsDirectlyCallable && visible.has(TOOL_CALL_RAW_TOOL_NAME)
      ? TOOL_CALL_RAW_TOOL_NAME
      : undefined;
  const deferredSkillTool = (name: string) => !visible.has(name) && available.has(name);
  return {
    canAccess,
    section: canAccess
      ? buildSkillsSection({
          skillsPrompt: params.skillsPrompt,
          readToolName: params.readToolName,
          codeModeActive: params.codeModeActive,
          installedSkillSearch: visible.has("skills_search"),
          installedSkillRead: visible.has("skills_read"),
          deferredSkillSearch: deferredSkillTool("skills_search"),
          deferredSkillRead: deferredSkillTool("skills_read"),
          skillsDispatcherToolName: dispatcher,
        })
      : [],
  };
}
