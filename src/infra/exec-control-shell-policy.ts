import { splitShellArgs } from "../utils/shell-argv.js";
import { buildCommandPayloadCandidates } from "./command-analysis/risks.js";
import { explainShellCommand } from "./command-explainer/extract.js";

export type ControlShellPolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "requires-approval"; warning: string };

export type ControlShellParsedSegment = {
  argv: string[];
  raw?: string;
  expandPayloadCandidates?: boolean;
};

type ControlShellCandidate = {
  argv: string[];
  raw: string;
};

type ControlShellInspection = {
  candidates: ControlShellCandidate[];
  heredocTexts: string[];
  redirectTargets: string[];
};

const INTERACTIVE_CHANNEL_LOGIN_DENY_MESSAGE = [
  "exec cannot run interactive OpenClaw channel login commands.",
  "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`).",
].join(" ");

const SECURITY_AUDIT_SUPPRESSION_WARNING =
  "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.";

const SSH_FILE_READ_WARNING = "Warning: Reading SSH files requires explicit approval.";

const CONTROL_OPTION_FLAGS_WITH_VALUES = new Set([
  "--channel",
  "--container",
  "--log-level",
  "--profile",
]);
const PACKAGE_MANAGER_NAMES = new Set(["pnpm", "npm", "yarn"]);
const PACKAGE_MANAGER_EXEC_COMMANDS = new Set(["exec", "dlx", "x"]);
const PACKAGE_MANAGER_RUN_COMMANDS = new Set(["run"]);
const PACKAGE_MANAGER_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-F",
  "--cache",
  "--config",
  "--cwd",
  "--dir",
  "--filter",
  "--global-dir",
  "--modules-dir",
  "--prefix",
  "--registry",
  "--store-dir",
  "--userconfig",
  "--virtual-store-dir",
  "--workspace",
]);
const PACKAGE_MANAGER_FLAG_OPTIONS = new Set(["-w", "--workspace-root"]);
const PACKAGE_EXEC_OPTIONS_WITH_VALUE = new Set(["-p", "--package", "-w", "--workspace"]);
const PACKAGE_EXEC_FLAG_OPTIONS = new Set(["-ws", "--workspaces", "--include-workspace-root"]);
const PACKAGE_EXEC_CALL_OPTIONS = new Set(["-c", "--call"]);

type ControlCommandOption = {
  name: string;
  value: string | true;
};

type NormalizedControlCommand = {
  executable: string;
  argv: string[];
  raw: string;
  words: string[];
  options: readonly ControlCommandOption[];
};

type ControlOptionPattern = {
  value?: string | RegExp;
};

type ControlOperandPattern = {
  value?: string | RegExp;
  pathUnder?: ".ssh";
};

type ControlCommandPattern = {
  executable?: string | readonly string[];
  command?: readonly (readonly string[])[];
  options?: Readonly<Record<string, ControlOptionPattern>>;
  operands?: readonly ControlOperandPattern[];
};

type ControlShellPolicyContext = {
  command: string;
  invocations: readonly NormalizedControlCommand[];
  heredocTexts: readonly string[];
  redirectTargets: readonly string[];
};

type ControlShellPolicy = {
  decision: Exclude<ControlShellPolicyDecision, { kind: "allow" }>;
  matches: (context: ControlShellPolicyContext) => boolean;
};

function normalizeCommandBaseName(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = token.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const normalized = base.replace(/\.(?:cmd|exe)$/u, "");
  return normalized === "openclaw" || normalized.startsWith("openclaw@") ? "openclaw" : normalized;
}

function optionName(token: string): string {
  return token.length > 1 ? token.replace(/[=].+$/u, "") : token;
}

function skipPackageManagerOptions(argv: readonly string[], startIndex: number): number {
  let index = startIndex;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return index + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
    const name = optionName(token);
    index += 1;
    if (PACKAGE_MANAGER_FLAG_OPTIONS.has(name)) {
      continue;
    }
    if (!token.includes("=") && PACKAGE_MANAGER_OPTIONS_WITH_VALUE.has(name)) {
      index += 1;
    }
  }
  return index;
}

function skipPackageExecOptions(argv: readonly string[], startIndex: number): number {
  let index = startIndex;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return index + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
    const name = optionName(token);
    index += 1;
    if (PACKAGE_EXEC_FLAG_OPTIONS.has(name)) {
      continue;
    }
    if (!token.includes("=") && PACKAGE_EXEC_OPTIONS_WITH_VALUE.has(name)) {
      index += 1;
    }
  }
  return index;
}

function packageOptionValue(params: {
  argv: readonly string[];
  index: number;
  options: ReadonlySet<string>;
}): { value: string; nextIndex: number } | null {
  const token = params.argv[params.index] ?? "";
  const name = optionName(token);
  if (params.options.has(name)) {
    if (token.includes("=")) {
      const delimiterIndex = token.indexOf("=");
      return { value: token.slice(delimiterIndex + 1), nextIndex: params.index + 1 };
    }
    const value = params.argv[params.index + 1];
    return value === undefined ? null : { value, nextIndex: params.index + 2 };
  }
  if (!token.startsWith("--")) {
    for (const option of params.options) {
      if (option.length === 2 && token.startsWith(option) && token.length > option.length) {
        return { value: token.slice(option.length), nextIndex: params.index + 1 };
      }
    }
  }
  return null;
}

function packageExecCallPayloadText(argv: readonly string[], startIndex: number): string | null {
  let index = startIndex;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return null;
    }
    if (!token.startsWith("-") || token === "-") {
      return null;
    }
    const call = packageOptionValue({
      argv,
      index,
      options: PACKAGE_EXEC_CALL_OPTIONS,
    });
    if (call) {
      return call.value.trim().length > 0 ? call.value : null;
    }
    const name = optionName(token);
    index += 1;
    if (PACKAGE_EXEC_FLAG_OPTIONS.has(name)) {
      continue;
    }
    if (!token.includes("=") && PACKAGE_EXEC_OPTIONS_WITH_VALUE.has(name)) {
      index += 1;
    }
  }
  return null;
}

function packageExecCallPayload(argv: readonly string[], startIndex: number): string[] | null {
  const payload = packageExecCallPayloadText(argv, startIndex);
  if (!payload) {
    return null;
  }
  const payloadArgv = splitShellArgs(payload) ?? payload.trim().split(/\s+/u);
  const normalized = payloadArgv.filter((part) => part.trim().length > 0);
  return normalized.length > 0 ? normalized : null;
}

function packageRunnerCallPayloadText(argv: readonly string[]): string | null {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (PACKAGE_MANAGER_NAMES.has(commandName)) {
    const packageCommandIndex = skipPackageManagerOptions(argv, 1);
    const packageCommand = argv[packageCommandIndex] ?? "";
    return PACKAGE_MANAGER_EXEC_COMMANDS.has(packageCommand)
      ? packageExecCallPayloadText(argv, packageCommandIndex + 1)
      : null;
  }
  return commandName === "npx" ? packageExecCallPayloadText(argv, 1) : null;
}

function stripOpenClawPackageRunner(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "openclaw") {
    return argv;
  }
  if (!PACKAGE_MANAGER_NAMES.has(commandName)) {
    return stripNpxPackageRunner(argv);
  }
  const packageCommandIndex = skipPackageManagerOptions(argv, 1);
  if (
    argv[packageCommandIndex] !== undefined &&
    normalizeCommandBaseName(argv[packageCommandIndex]) === "openclaw"
  ) {
    return argv.slice(packageCommandIndex);
  }
  const packageCommand = argv[packageCommandIndex] ?? "";
  if (PACKAGE_MANAGER_EXEC_COMMANDS.has(packageCommand)) {
    const callPayload = packageExecCallPayload(argv, packageCommandIndex + 1);
    if (callPayload) {
      return callPayload;
    }
    const payloadIndex = skipPackageExecOptions(argv, packageCommandIndex + 1);
    return payloadIndex < argv.length ? argv.slice(payloadIndex) : argv;
  }
  if (PACKAGE_MANAGER_RUN_COMMANDS.has(packageCommand)) {
    const payloadIndex = skipPackageExecOptions(argv, packageCommandIndex + 1);
    if (
      argv[payloadIndex] !== undefined &&
      normalizeCommandBaseName(argv[payloadIndex]) === "openclaw"
    ) {
      return argv.slice(payloadIndex);
    }
  }
  return argv;
}

function stripNpxPackageRunner(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "bun" && normalizeCommandBaseName(argv[1]) === "openclaw") {
    return argv.slice(1);
  }
  if (commandName === "npx" || commandName === "bunx") {
    if (commandName === "npx") {
      const callPayload = packageExecCallPayload(argv, 1);
      if (callPayload) {
        return callPayload;
      }
    }
    let index = 1;
    while (index < argv.length) {
      const token = argv[index] ?? "";
      if (token === "--") {
        index += 1;
        break;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      index += 1;
      if ((token === "-p" || token === "--package") && index < argv.length) {
        index += 1;
      }
    }
    if (normalizeCommandBaseName(argv[index]) === "openclaw") {
      return argv.slice(index);
    }
  }
  return argv;
}

function textMentionsSecurityAuditSuppressions(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("security.audit.suppressions") ||
    /["']?security["']?[\s\S]{0,200}["']?audit["']?[\s\S]{0,200}["']?suppressions["']?/.test(
      normalized,
    )
  );
}

function normalizeOptionName(token: string): string {
  return token.length > 1 ? token.replace(/[=].+$/u, "") : token;
}

function appendOption(options: ControlCommandOption[], name: string, value: string | true): void {
  options.push({ name: normalizeOptionName(name), value });
}

function parseNormalizedCommandWords(argv: string[]): {
  executable: string;
  words: string[];
  options: ControlCommandOption[];
} | null {
  const strippedArgv = stripOpenClawPackageRunner(argv);
  const executable = normalizeCommandBaseName(strippedArgv[0]);
  if (!executable) {
    return null;
  }
  const words: string[] = [];
  const options: ControlCommandOption[] = [];
  let index = 1;
  let optionsTerminated = false;

  while (index < strippedArgv.length) {
    const token = strippedArgv[index] ?? "";
    if (!optionsTerminated && token === "--") {
      optionsTerminated = true;
      index += 1;
      continue;
    }
    if (!optionsTerminated && token.startsWith("--") && token.length > 2) {
      const equalsIndex = token.indexOf("=");
      if (equalsIndex > 2) {
        appendOption(options, token.slice(0, equalsIndex), token.slice(equalsIndex + 1));
        index += 1;
        continue;
      }
      if (CONTROL_OPTION_FLAGS_WITH_VALUES.has(token) && strippedArgv[index + 1] !== undefined) {
        appendOption(options, token, strippedArgv[index + 1] ?? "");
        index += 2;
        continue;
      }
      appendOption(options, token, true);
      index += 1;
      continue;
    }
    if (!optionsTerminated && token.startsWith("-") && token !== "-") {
      appendOption(options, token, true);
      index += 1;
      continue;
    }
    words.push(token);
    index += 1;
  }

  return { executable, words, options };
}

function normalizeControlCommand(
  candidate: ControlShellCandidate,
): NormalizedControlCommand | null {
  const parsed = parseNormalizedCommandWords(candidate.argv);
  if (!parsed) {
    return null;
  }
  return {
    executable: parsed.executable,
    argv: candidate.argv,
    raw: candidate.raw,
    words: parsed.words,
    options: parsed.options,
  };
}

function normalizeControlCommands(
  candidates: readonly ControlShellCandidate[],
): NormalizedControlCommand[] {
  return candidates.flatMap((candidate) => {
    const normalized = normalizeControlCommand(candidate);
    return normalized ? [normalized] : [];
  });
}

function commandText(invocation: NormalizedControlCommand): string {
  return `${invocation.raw} ${invocation.argv.join(" ")}`;
}

function invocationMentionsSecurityAuditSuppressions(
  invocation: NormalizedControlCommand,
): boolean {
  return textMentionsSecurityAuditSuppressions(commandText(invocation));
}

function removeCandidateText(
  command: string,
  invocations: readonly NormalizedControlCommand[],
): string {
  let remaining = command;
  for (const invocation of invocations) {
    const raw = invocation.raw.trim();
    if (raw.length === 0) {
      continue;
    }
    remaining = remaining.replace(raw, " ");
  }
  return remaining;
}

function stringOrRegexMatches(pattern: string | RegExp, value: string): boolean {
  return typeof pattern === "string" ? value === pattern : pattern.test(value);
}

function matchesOneOf(value: string, expected: string | readonly string[] | undefined): boolean {
  if (expected === undefined) {
    return true;
  }
  return typeof expected === "string" ? value === expected : expected.includes(value);
}

function commandPathMatches(
  invocation: NormalizedControlCommand,
  command: ControlCommandPattern["command"],
): boolean {
  const paths = command ?? [];
  if (paths.length === 0) {
    return true;
  }
  return paths.some((path) => {
    if (path.length > invocation.words.length) {
      return false;
    }
    return path.every((part, index) => invocation.words[index] === part);
  });
}

function optionMatches(
  invocation: NormalizedControlCommand,
  optionName: string,
  pattern: ControlOptionPattern,
): boolean {
  const matches = invocation.options.filter((option) => option.name === optionName);
  const expectedValue = pattern.value;
  if (expectedValue === undefined) {
    return matches.length > 0;
  }
  return matches.some(
    (option) => option.value !== true && stringOrRegexMatches(expectedValue, option.value),
  );
}

function pathMatchesStaticSshPath(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/");
  return (
    normalized === "~/.ssh" ||
    normalized.startsWith("~/.ssh/") ||
    normalized === ".ssh" ||
    normalized.startsWith(".ssh/") ||
    normalized === "./.ssh" ||
    normalized.startsWith("./.ssh/") ||
    normalized.includes("/.ssh/")
  );
}

function textMentionsStaticSshPath(value: string): boolean {
  const normalized = value.replace(/\\/gu, "/");
  return (
    /(?:^|[^A-Za-z0-9_./~-])(?:~\/\.ssh|\.\/\.ssh|\.ssh)(?:\/|$|[^A-Za-z0-9_./-])/u.test(
      normalized,
    ) || /(?:^|[^A-Za-z0-9_./-])\/[^"'`\s]*\/\.ssh(?:\/|$|[^A-Za-z0-9_./-])/u.test(normalized)
  );
}

function operandMatches(value: string, pattern: ControlOperandPattern): boolean {
  if (pattern.value !== undefined && !stringOrRegexMatches(pattern.value, value)) {
    return false;
  }
  if (pattern.pathUnder === ".ssh" && !pathMatchesStaticSshPath(value)) {
    return false;
  }
  return true;
}

function matchesControlCommandPattern(params: {
  invocation: NormalizedControlCommand;
  pattern: ControlCommandPattern;
}): boolean {
  const pattern = params.pattern;
  if (!matchesOneOf(params.invocation.executable, pattern.executable)) {
    return false;
  }
  if (!commandPathMatches(params.invocation, pattern.command)) {
    return false;
  }
  for (const [optionName, optionPattern] of Object.entries(pattern.options ?? {})) {
    if (!optionMatches(params.invocation, optionName, optionPattern)) {
      return false;
    }
  }
  for (const operandPattern of pattern.operands ?? []) {
    if (!params.invocation.words.some((operand) => operandMatches(operand, operandPattern))) {
      return false;
    }
  }
  return true;
}

function hasMatchingInvocation(params: {
  invocations: readonly NormalizedControlCommand[];
  patterns: readonly ControlCommandPattern[];
}): boolean {
  return params.invocations.some((invocation) =>
    params.patterns.some((pattern) => matchesControlCommandPattern({ invocation, pattern })),
  );
}

const INTERACTIVE_CHANNEL_LOGIN_PATTERNS: readonly ControlCommandPattern[] = [
  { executable: "openclaw", command: [["channels", "login"]] },
  { executable: "openclaw", command: [["channel", "login"]] },
];

const READ_ONLY_SECURITY_AUDIT_SUPPRESSION_PATTERNS: readonly ControlCommandPattern[] = [
  { executable: "openclaw", command: [["config", "get"]] },
  { executable: "openclaw", command: [["config", "schema"]] },
  { executable: "openclaw", command: [["config", "validate"]] },
];

const MUTATING_SECURITY_AUDIT_SUPPRESSION_PATTERNS: readonly ControlCommandPattern[] = [
  { executable: "openclaw", command: [["config", "set"]] },
  { executable: "openclaw", command: [["config", "unset"]] },
  { executable: "openclaw", command: [["config", "patch"]] },
  { executable: "openclaw", command: [["config", "apply"]] },
];

const SSH_FILE_READ_PATTERNS: readonly ControlCommandPattern[] = [
  {
    executable: [
      "awk",
      "cat",
      "cp",
      "dd",
      "grep",
      "head",
      "less",
      "more",
      "powershell",
      "python",
      "python3",
      "sed",
      "tail",
      "tar",
    ],
    operands: [{ pathUnder: ".ssh" }],
  },
];

const SSH_FILE_READER_EXECUTABLES = new Set([
  "awk",
  "cat",
  "cp",
  "dd",
  "grep",
  "head",
  "less",
  "more",
  "powershell",
  "python",
  "python3",
  "sed",
  "tail",
  "tar",
]);

const CURL_UPLOAD_FILE_OPTIONS = new Set(["-T", "--upload-file"]);
const CURL_FILE_READ_OPTIONS = new Set(["-K", "--config", "--netrc-file"]);
const CURL_FILE_URL_OPTIONS = new Set(["--url"]);
const CURL_STACKABLE_SHORT_FLAG_OPTIONS = new Set([
  "a",
  "f",
  "G",
  "g",
  "I",
  "i",
  "J",
  "j",
  "k",
  "L",
  "l",
  "M",
  "N",
  "n",
  "O",
  "p",
  "q",
  "R",
  "S",
  "s",
  "Z",
]);
const CURL_AT_FILE_OPTIONS = new Set([
  "-d",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-urlencode",
  "-F",
  "--form",
]);
const CURL_NAME_AT_FILE_OPTIONS = new Set(["--data-urlencode"]);

function requiresSecurityAuditSuppressionApproval(params: {
  command: string;
  invocations: readonly NormalizedControlCommand[];
  heredocTexts: readonly string[];
}): boolean {
  const mentioningInvocations = params.invocations.filter(
    invocationMentionsSecurityAuditSuppressions,
  );
  if (mentioningInvocations.length > 0) {
    if (
      hasMatchingInvocation({
        invocations: mentioningInvocations,
        patterns: MUTATING_SECURITY_AUDIT_SUPPRESSION_PATTERNS,
      })
    ) {
      return true;
    }
    if (
      mentioningInvocations.every((invocation) =>
        READ_ONLY_SECURITY_AUDIT_SUPPRESSION_PATTERNS.some((pattern) =>
          matchesControlCommandPattern({
            invocation,
            pattern,
          }),
        ),
      )
    ) {
      return textMentionsSecurityAuditSuppressions(
        removeCandidateText(params.command, mentioningInvocations),
      );
    }
    return true;
  }

  if (!textMentionsSecurityAuditSuppressions(params.command)) {
    return false;
  }
  return true;
}

function redirectTokenPathCandidates(text: string): string[] {
  const tokens = splitShellArgs(text) ?? text.trim().split(/\s+/u);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const attached = /^(?:\d+)?(?:<>|>>|[<>]|&>)(.+)$/u.exec(token)?.[1];
    if (attached) {
      paths.push(attached);
      continue;
    }
    if (/^(?:\d+)?(?:<>|>>|[<>]|&>)$/u.test(token)) {
      const next = tokens[index + 1];
      if (next) {
        paths.push(next);
      }
    }
  }
  return paths;
}

function curlFileOperandPathCandidates(value: string, option: string): string[] {
  const trimmed = value.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("@") || trimmed.startsWith("<")) {
    candidates.push(trimmed.slice(1));
  }
  const formFile = /(?:^|=)(?:@|<)([^;]+)/u.exec(trimmed)?.[1];
  if (formFile) {
    candidates.push(formFile);
  }
  if (CURL_NAME_AT_FILE_OPTIONS.has(option)) {
    const namedFile = /^[^=@<]+@([^;]+)/u.exec(trimmed)?.[1];
    if (namedFile) {
      candidates.push(namedFile);
    }
  }
  return candidates;
}

function combinedCurlShortOptionIndex(token: string, option: string): number {
  const optionChar = option[1];
  if (!optionChar || !token.startsWith("-") || token.startsWith("--")) {
    return -1;
  }
  const optionIndex = token.indexOf(optionChar, 1);
  if (optionIndex < 1) {
    return -1;
  }
  const prefix = token.slice(1, optionIndex);
  for (let index = 0; index < prefix.length; index += 1) {
    if (!CURL_STACKABLE_SHORT_FLAG_OPTIONS.has(prefix[index] ?? "")) {
      return -1;
    }
  }
  return optionIndex;
}

function curlOptionValue(params: {
  argv: readonly string[];
  index: number;
  option: string;
}): { option: string; value: string; nextIndex: number } | null {
  const token = params.argv[params.index] ?? "";
  if (token === params.option) {
    const value = params.argv[params.index + 1];
    return value === undefined
      ? null
      : { option: params.option, value, nextIndex: params.index + 2 };
  }
  if (params.option.startsWith("--") && token.startsWith(`${params.option}=`)) {
    return {
      option: params.option,
      value: token.slice(params.option.length + 1),
      nextIndex: params.index + 1,
    };
  }
  if (params.option.startsWith("-") && !params.option.startsWith("--")) {
    const attached = token.startsWith(params.option) ? token.slice(params.option.length) : "";
    if (attached.length > 0) {
      return { option: params.option, value: attached, nextIndex: params.index + 1 };
    }
    const optionIndex = combinedCurlShortOptionIndex(token, params.option);
    if (optionIndex >= 1) {
      const value = token.slice(optionIndex + 1);
      if (value.length > 0) {
        return { option: params.option, value, nextIndex: params.index + 1 };
      }
      const next = params.argv[params.index + 1];
      return next === undefined
        ? null
        : { option: params.option, value: next, nextIndex: params.index + 2 };
    }
  }
  return null;
}

function curlFileUrlPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) {
    return null;
  }
  let path = trimmed.slice("file://".length);
  if (path.startsWith("localhost/")) {
    path = path.slice("localhost".length);
  } else if (!path.startsWith("/")) {
    const slashIndex = path.indexOf("/");
    if (slashIndex === -1) {
      return null;
    }
    path = path.slice(slashIndex);
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function curlFileUrlMatchesStaticSshPath(value: string): boolean {
  const path = curlFileUrlPath(value);
  return path !== null && pathMatchesStaticSshPath(path);
}

function curlReadsSshFile(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; ) {
    const token = argv[index] ?? "";
    if (token === "--") {
      return argv.slice(index + 1).some(curlFileUrlMatchesStaticSshPath);
    }
    if (curlFileUrlMatchesStaticSshPath(token)) {
      return true;
    }
    const fileRead = [...CURL_FILE_READ_OPTIONS]
      .map((option) => curlOptionValue({ argv, index, option }))
      .find(
        (match): match is { option: string; value: string; nextIndex: number } => match !== null,
      );
    if (fileRead) {
      if (pathMatchesStaticSshPath(fileRead.value)) {
        return true;
      }
      index = fileRead.nextIndex;
      continue;
    }
    const fileUrl = [...CURL_FILE_URL_OPTIONS]
      .map((option) => curlOptionValue({ argv, index, option }))
      .find(
        (match): match is { option: string; value: string; nextIndex: number } => match !== null,
      );
    if (fileUrl) {
      if (curlFileUrlMatchesStaticSshPath(fileUrl.value)) {
        return true;
      }
      index = fileUrl.nextIndex;
      continue;
    }
    const upload = [...CURL_UPLOAD_FILE_OPTIONS]
      .map((option) => curlOptionValue({ argv, index, option }))
      .find(
        (match): match is { option: string; value: string; nextIndex: number } => match !== null,
      );
    if (upload) {
      if (pathMatchesStaticSshPath(upload.value)) {
        return true;
      }
      index = upload.nextIndex;
      continue;
    }
    const atFile = [...CURL_AT_FILE_OPTIONS]
      .map((option) => curlOptionValue({ argv, index, option }))
      .find(
        (match): match is { option: string; value: string; nextIndex: number } => match !== null,
      );
    if (atFile) {
      if (
        curlFileOperandPathCandidates(atFile.value, atFile.option).some(pathMatchesStaticSshPath)
      ) {
        return true;
      }
      index = atFile.nextIndex;
      continue;
    }
    index += 1;
  }
  return false;
}

function requiresSshFileReadApproval(params: {
  command: string;
  invocations: readonly NormalizedControlCommand[];
  heredocTexts: readonly string[];
  redirectTargets: readonly string[];
}): boolean {
  if (
    hasMatchingInvocation({
      invocations: params.invocations,
      patterns: SSH_FILE_READ_PATTERNS,
    })
  ) {
    return true;
  }
  for (const invocation of params.invocations) {
    if (
      SSH_FILE_READER_EXECUTABLES.has(invocation.executable) &&
      textMentionsStaticSshPath(commandText(invocation))
    ) {
      return true;
    }
    if (invocation.executable === "curl" && curlReadsSshFile(invocation.argv)) {
      return true;
    }
  }
  return (
    params.redirectTargets.some(pathMatchesStaticSshPath) ||
    params.heredocTexts.some(textMentionsStaticSshPath)
  );
}

export function parseOpenClawChannelsLoginShellCommand(raw: string): boolean {
  const argv = splitShellArgs(raw);
  if (!argv) {
    return false;
  }
  const invocation = normalizeControlCommand({ argv, raw });
  return invocation
    ? INTERACTIVE_CHANNEL_LOGIN_PATTERNS.some((pattern) =>
        matchesControlCommandPattern({ invocation, pattern }),
      )
    : false;
}

const CONTROL_SHELL_POLICIES: readonly ControlShellPolicy[] = [
  {
    decision: { kind: "deny", message: INTERACTIVE_CHANNEL_LOGIN_DENY_MESSAGE },
    matches: ({ invocations }) =>
      hasMatchingInvocation({
        invocations,
        patterns: INTERACTIVE_CHANNEL_LOGIN_PATTERNS,
      }),
  },
  {
    decision: { kind: "requires-approval", warning: SECURITY_AUDIT_SUPPRESSION_WARNING },
    matches: requiresSecurityAuditSuppressionApproval,
  },
  {
    decision: { kind: "requires-approval", warning: SSH_FILE_READ_WARNING },
    matches: requiresSshFileReadApproval,
  },
];

function appendCandidate(
  candidates: ControlShellCandidate[],
  seen: Set<string>,
  candidate: ControlShellCandidate,
): void {
  const key = `${candidate.raw}\0${candidate.argv.join("\0")}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push(candidate);
}

function candidateFromRaw(raw: string): ControlShellCandidate {
  return {
    argv: splitShellArgs(raw) ?? [],
    raw,
  };
}

function appendPayloadCandidates(params: {
  candidates: ControlShellCandidate[];
  seen: Set<string>;
  argv: string[];
}): void {
  for (const payload of buildCommandPayloadCandidates(params.argv)) {
    appendCandidate(params.candidates, params.seen, candidateFromRaw(payload));
  }
}

async function appendShellCommandTextCandidates(params: {
  raw: string;
  candidates: ControlShellCandidate[];
  seen: Set<string>;
  heredocTexts: string[];
  redirectTargets: string[];
  depth?: number;
}): Promise<boolean> {
  const depth = params.depth ?? 0;
  if (depth > 4) {
    return false;
  }
  try {
    const explanation = await explainShellCommand(params.raw);
    if (!explanation.ok) {
      return false;
    }
    for (const risk of explanation.risks) {
      if (risk.kind === "redirect") {
        params.redirectTargets.push(...redirectTokenPathCandidates(risk.text));
      } else if (risk.kind === "heredoc") {
        params.heredocTexts.push(risk.text);
      }
    }
    for (const step of [...explanation.topLevelCommands, ...explanation.nestedCommands]) {
      appendCandidate(params.candidates, params.seen, {
        argv: step.argv,
        raw: step.text,
      });
      appendPayloadCandidates({
        candidates: params.candidates,
        seen: params.seen,
        argv: step.argv,
      });
      const packagePayload = packageRunnerCallPayloadText(step.argv);
      if (packagePayload) {
        await appendShellCommandTextCandidates({
          ...params,
          raw: packagePayload,
          depth: depth + 1,
        });
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function buildControlShellCandidates(params: {
  command: string;
  parsedSegments?: readonly ControlShellParsedSegment[];
}): Promise<ControlShellInspection> {
  const candidates: ControlShellCandidate[] = [];
  const heredocTexts: string[] = [];
  const redirectTargets: string[] = [];
  const seen = new Set<string>();

  for (const segment of params.parsedSegments ?? []) {
    appendCandidate(candidates, seen, {
      argv: segment.argv,
      raw: segment.raw ?? segment.argv.join(" "),
    });
    if (segment.expandPayloadCandidates !== false) {
      appendPayloadCandidates({
        candidates,
        seen,
        argv: segment.argv,
      });
      const packagePayload = packageRunnerCallPayloadText(segment.argv);
      if (packagePayload) {
        await appendShellCommandTextCandidates({
          raw: packagePayload,
          candidates,
          seen,
          heredocTexts,
          redirectTargets,
        });
      }
    }
  }
  if (params.command.trim().length === 0) {
    return { candidates, heredocTexts, redirectTargets };
  }

  if (
    await appendShellCommandTextCandidates({
      raw: params.command,
      candidates,
      seen,
      heredocTexts,
      redirectTargets,
    })
  ) {
    return { candidates, heredocTexts, redirectTargets };
  }

  for (const line of params.command.split(/\r?\n/u)) {
    const raw = line.trim();
    if (raw.length === 0) {
      continue;
    }
    const fallback = candidateFromRaw(raw);
    appendCandidate(candidates, seen, fallback);
    appendPayloadCandidates({
      candidates,
      seen,
      argv: fallback.argv,
    });
    const packagePayload = packageRunnerCallPayloadText(fallback.argv);
    if (packagePayload) {
      await appendShellCommandTextCandidates({
        raw: packagePayload,
        candidates,
        seen,
        heredocTexts,
        redirectTargets,
      });
    }
  }

  return { candidates, heredocTexts, redirectTargets };
}

export async function inspectControlShellCommand(params: {
  command: string;
  parsedSegments?: readonly ControlShellParsedSegment[];
}): Promise<ControlShellPolicyDecision> {
  const command = params.command.trim();
  const inspection = await buildControlShellCandidates({
    command,
    parsedSegments: params.parsedSegments,
  });
  const invocations = normalizeControlCommands(inspection.candidates);

  for (const policy of CONTROL_SHELL_POLICIES) {
    if (
      policy.matches({
        command,
        invocations,
        heredocTexts: inspection.heredocTexts,
        redirectTargets: inspection.redirectTargets,
      })
    ) {
      return policy.decision;
    }
  }

  return { kind: "allow" };
}
