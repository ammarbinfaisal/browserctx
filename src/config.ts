import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type RawLogSettings = {
  mode?: unknown;
  dest?: unknown;
  format?: unknown;
  file?: unknown;
  redact?: unknown;
  include?: unknown;
  exclude?: unknown;
};

type RawToolSettings = {
  enabled?: unknown;
  disabled?: unknown;
};

type RawSettingsFile = {
  host?: unknown;
  wsPort?: unknown;
  controlPort?: unknown;
  log?: RawLogSettings;
  tools?: RawToolSettings;
};

type ResolvedSettingsFile = {
  createdDefaultPath?: string;
  paths: string[];
  sources: Array<{
    path: string;
    settings: RawSettingsFile;
  }>;
  settings: RawSettingsFile;
};

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "1":
      case "true":
      case "yes":
      case "on":
        return true;
      case "0":
      case "false":
      case "no":
      case "off":
        return false;
    }
  }
  return undefined;
}

function stringListValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return undefined;
}

function userHomeDir(): string {
  return envValue("HOME", "USERPROFILE") ?? homedir();
}

function defaultConfigFilePath(): string {
  const home = userHomeDir();
  if (process.platform === "win32") {
    return join(
      envValue("APPDATA") ?? join(home, "AppData", "Roaming"),
      "Tabductor",
      "config.json",
    );
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Tabductor", "config.json");
  }
  return join(
    envValue("XDG_CONFIG_HOME") ?? join(home, ".config"),
    "tabductor",
    "config.json",
  );
}

function defaultLogFilePath(): string {
  const home = userHomeDir();
  if (process.platform === "win32") {
    return join(
      envValue("LOCALAPPDATA") ?? join(home, "AppData", "Local"),
      "Tabductor",
      "Logs",
      "tabductor.log",
    );
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Logs", "Tabductor", "tabductor.log");
  }
  return join(
    envValue("XDG_STATE_HOME") ?? join(home, ".local", "state"),
    "tabductor",
    "tabductor.log",
  );
}

function projectConfigCandidates(): string[] {
  return [
    resolve(process.cwd(), ".tabductor.json"),
    resolve(process.cwd(), "tabductor.config.json"),
  ];
}

function readSettingsFile(path: string): RawSettingsFile {
  const rawText = readFileSync(path, "utf8");
  const parsed = JSON.parse(rawText) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${path}`);
  }
  return parsed as RawSettingsFile;
}

function mergeSettings(base: RawSettingsFile, next: RawSettingsFile): RawSettingsFile {
  return {
    ...base,
    ...next,
    log: {
      ...(base.log ?? {}),
      ...(next.log ?? {}),
    },
    tools: {
      ...(base.tools ?? {}),
      ...(next.tools ?? {}),
    },
  };
}

function defaultConfigText() {
  return `${JSON.stringify(
    {
      host: "127.0.0.1",
      wsPort: 8765,
      controlPort: 8766,
      tools: {
        disabled: ["navigate"],
      },
      log: {
        mode: "errors",
        dest: "auto",
        file: defaultLogFilePath(),
        redact: true,
        include: [],
        exclude: [],
      },
    },
    null,
    2,
  )}\n`;
}

function ensureDefaultConfig(path: string): string | undefined {
  if (existsSync(path)) {
    return undefined;
  }

  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, defaultConfigText(), { encoding: "utf8", flag: "wx" });
    return path;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return undefined;
    }
    throw error;
  }
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function loadSettingsFile(): ResolvedSettingsFile {
  const explicitPath = envValue("TABDUCTOR_CONFIG");
  if (explicitPath) {
    const path = resolve(explicitPath);
    if (!existsSync(path)) {
      return {
        paths: [],
        sources: [],
        settings: {},
      };
    }
    const settings = readSettingsFile(path);
    return {
      paths: [path],
      sources: [{ path, settings }],
      settings,
    };
  }

  const globalConfigPath = defaultConfigFilePath();
  const candidatePaths = dedupePaths([
    globalConfigPath,
    ...projectConfigCandidates(),
  ]);
  let createdDefaultPath: string | undefined;
  if (!candidatePaths.some((path) => existsSync(path))) {
    createdDefaultPath = ensureDefaultConfig(globalConfigPath);
  }

  let settings: RawSettingsFile = {};
  const loadedPaths: string[] = [];
  const loadedSources: ResolvedSettingsFile["sources"] = [];
  for (const path of candidatePaths) {
    if (!existsSync(path)) {
      continue;
    }
    const sourceSettings = readSettingsFile(path);
    settings = mergeSettings(settings, sourceSettings);
    loadedPaths.push(path);
    loadedSources.push({
      path,
      settings: sourceSettings,
    });
  }

  return {
    createdDefaultPath,
    paths: loadedPaths,
    sources: loadedSources,
    settings,
  };
}

const configFile = loadSettingsFile();
const fileSettings = configFile.settings;
const fileLogSettings = fileSettings.log ?? {};

function envNumber(name: string): number | undefined {
  return numberValue(envValue(name));
}

function envBoolean(name: string): boolean | undefined {
  return booleanValue(envValue(name));
}

function envCsv(name: string): string[] | undefined {
  return stringListValue(envValue(name));
}

function normalizeToolName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return normalized;
  }
  return normalized.startsWith("tabductor_")
    ? normalized
    : `tabductor_${normalized}`;
}

function normalizedToolNames(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }
  return [...new Set(values.map(normalizeToolName).filter(Boolean))];
}

const defaultDisabledTools = normalizedToolNames(["navigate"]);
const envEnabledTools = normalizedToolNames(envCsv("TABDUCTOR_ENABLE_TOOLS"));
const envDisabledTools = normalizedToolNames(envCsv("TABDUCTOR_DISABLE_TOOLS"));
const disabledToolNames = new Set(defaultDisabledTools);

for (const source of configFile.sources) {
  const toolSettings = source.settings.tools ?? {};
  for (const toolName of normalizedToolNames(stringListValue(toolSettings.enabled))) {
    disabledToolNames.delete(toolName);
  }
  for (const toolName of normalizedToolNames(stringListValue(toolSettings.disabled))) {
    disabledToolNames.add(toolName);
  }
}
for (const toolName of envEnabledTools) {
  disabledToolNames.delete(toolName);
}
for (const toolName of envDisabledTools) {
  disabledToolNames.add(toolName);
}

export const appConfig = {
  name: "@tabductor/mcp",
  configFilePath: configFile.paths.at(-1),
  configFilePaths: configFile.paths,
  createdDefaultConfigPath: configFile.createdDefaultPath,
  defaultConfigPath: defaultConfigFilePath(),
} as const;

export const mcpConfig = {
  defaultWsPort: envNumber("TABDUCTOR_WS_PORT")
    ?? numberValue(fileSettings.wsPort)
    ?? 8765,
  defaultControlPort: envNumber("TABDUCTOR_CONTROL_PORT")
    ?? numberValue(fileSettings.controlPort)
    ?? 8766,
  defaultHost: envValue("TABDUCTOR_HOST")
    ?? stringValue(fileSettings.host)
    ?? "127.0.0.1",
  log: {
    mode: envValue("TABDUCTOR_LOG_MODE")
      ?? stringValue(fileLogSettings.mode),
    dest: envValue("TABDUCTOR_LOG_DEST")
      ?? stringValue(fileLogSettings.dest),
    format: envValue("TABDUCTOR_LOG_FORMAT")
      ?? stringValue(fileLogSettings.format),
    file: envValue("TABDUCTOR_LOG_FILE")
      ?? stringValue(fileLogSettings.file)
      ?? defaultLogFilePath(),
    redact: envBoolean("TABDUCTOR_LOG_REDACT")
      ?? booleanValue(fileLogSettings.redact)
      ?? true,
    include: envCsv("TABDUCTOR_LOG_INCLUDE")
      ?? stringListValue(fileLogSettings.include)
      ?? [],
    exclude: envCsv("TABDUCTOR_LOG_EXCLUDE")
      ?? stringListValue(fileLogSettings.exclude)
      ?? [],
    debug: envBoolean("TABDUCTOR_DEBUG") ?? false,
    debugFull: envBoolean("TABDUCTOR_DEBUG_FULL") ?? false,
  },
  tools: {
    disabled: [...disabledToolNames],
  },
  errors: {
    noConnectedTab: "NO_CONNECTED_TAB",
    staleRef: "STALE_REF",
  },
};

export function isToolEnabled(name: string): boolean {
  return !disabledToolNames.has(normalizeToolName(name));
}
