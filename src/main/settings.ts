import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SecretKey } from './keychain';
import { ALL_SECRET_KEYS, loadSecrets, setSecret } from './keychain';
import type { ProviderId } from './providers/types';

// ─── Secret path helpers (single place for "what is a secret" + where it lives) ───
// SecretKey is the path as string, e.g. 'claude.anthropicApiKey' → ['claude', 'anthropicApiKey']

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads a nested value by path. Returns `undefined` if any segment is missing.
 * Example:
 * ```
 * const settings = {
 *   claude: {
 *     anthropicApiKey: '1234567890',
 *   },
 * };
 * const value = getByPath(settings, ['claude', 'anthropicApiKey']);
 * console.log(value); // '1234567890'
 * ```
 * @param pathSegments - Dot-split path, e.g. `['claude', 'anthropicApiKey']`
 */
function getByPath(
  obj: Record<string, unknown>,
  pathSegments: string[],
): unknown {
  // recursively retrieves a nested property value from an object using a path (array of keys),
  // returning undefined if any key along the path does not exist or the path is invalid.
  if (pathSegments.length === 0) return obj;
  const valueAtSegment = obj[pathSegments[0]];
  if (valueAtSegment == null) return undefined;
  if (pathSegments.length === 1) return valueAtSegment;
  if (isPlainObject(valueAtSegment))
    return getByPath(valueAtSegment, pathSegments.slice(1));
  return undefined;
}

/**
 * Removes a property at a nested path. No-op if the path doesn't exist.
 * @param pathSegments - Dot-split path, e.g. `['gemini', 'apiKey']`
 */
function deleteByPath(
  obj: Record<string, unknown>,
  pathSegments: string[],
): void {
  if (pathSegments.length === 0) return;
  if (pathSegments.length === 1) {
    delete obj[pathSegments[0]];
    return;
  }
  const nested = obj[pathSegments[0]];
  if (isPlainObject(nested)) {
    deleteByPath(nested, pathSegments.slice(1));
  }
}

/**
 * Returns a deep clone of settings with every secret key (see keychain ALL_SECRET_KEYS) removed.
 * Use this before writing to the JSON file so API keys never touch disk.
 * @param settings - Full or partial app settings; may contain secrets
 * @returns Same shape without secret fields; safe to persist
 */
function toDiskSafe(
  settings: Record<string, unknown>,
): Partial<PersistedSettings> {
  const withoutSecrets = JSON.parse(
    JSON.stringify(settings),
  ) as Partial<PersistedSettings>;
  for (const secretKey of ALL_SECRET_KEYS) {
    deleteByPath(withoutSecrets, secretKey.split('.'));
  }
  return withoutSecrets;
}

/**
 * Builds full AppSettings from disk-only settings plus keychain secrets.
 * Injects each secret at the path implied by its key (e.g. `claude.anthropicApiKey` → `result.claude.anthropicApiKey`).
 * @param diskSettings - Persisted settings (no API keys)
 * @param secrets - Values from loadSecrets()
 * @returns Complete settings with secrets filled in
 */
function hydrateWithSecrets(
  diskSettings: PersistedSettings,
  secrets: Record<SecretKey, string>,
): AppSettings {
  return {
    ...diskSettings,
    claude: {
      ...diskSettings.claude,
      anthropicApiKey: secrets['claude.anthropicApiKey'] ?? '',
    },
    gemini: {
      ...diskSettings.gemini,
      apiKey: secrets['gemini.apiKey'] ?? '',
    },
    codex: {
      ...diskSettings.codex,
      apiKey: secrets['codex.apiKey'] ?? '',
    },
    opencode: {
      ...diskSettings.opencode,
      apiKey: secrets['opencode.apiKey'] ?? '',
    },
import { loadSecrets, setSecret } from './keychain';
import type { SecretKey } from './keychain';
  };
}

export interface ClaudeSettings {
  authMode: 'auto' | 'vertex' | 'api-key';
  anthropicApiKey: string; // loaded from keychain at runtime, never saved to disk
  vertexProjectId: string;
  vertexRegion: string;
  model: string;
  permissionMode: string;
  effort: string;
}

export interface GeminiSettings {
  apiKey: string; // loaded from keychain at runtime, never saved to disk
  model: string;
}

export interface CodexSettings {
  apiKey: string; // loaded from keychain at runtime, never saved to disk
  model: string;
}

export interface OpenCodeSettings {
  provider: string;
  apiKey: string; // loaded from keychain at runtime, never saved to disk
  model: string;
}

export interface AppSettings {
  provider: ProviderId;

  claude: ClaudeSettings;
  gemini: GeminiSettings;
  codex: CodexSettings;
  opencode: OpenCodeSettings;

  maxTurns: number;
  skills: string[];
  lastProjectPath: string;
  selectedProjectPath: string;
  theme: 'light' | 'dark';
}

// What actually gets written to / read from the JSON file on disk.
// API keys are deliberately absent — they live in the OS keychain.
type PersistedSettings = Omit<AppSettings,
  'claude' | 'gemini' | 'codex' | 'opencode'
> & {
  claude: Omit<ClaudeSettings, 'anthropicApiKey'>;
  gemini: Omit<GeminiSettings, 'apiKey'>;
  codex: Omit<CodexSettings, 'apiKey'>;
  opencode: Omit<OpenCodeSettings, 'apiKey'>;
};

const DISK_DEFAULTS: PersistedSettings = {
  provider: '' as ProviderId,
  claude: {
    authMode: 'auto',
    vertexProjectId: '',
    vertexRegion: 'global',
    model: '',
    permissionMode: 'bypassPermissions',
    effort: 'high',
  },
  gemini: { model: '' },
  codex: { model: '' },
  opencode: { provider: 'anthropic', model: '' },
  maxTurns: 25,
  skills: [],
  lastProjectPath: '',
  selectedProjectPath: '',
  theme: 'light',
};

let diskCached: PersistedSettings | null = null;

/** Path to the JSON settings file in the app userData directory. */
function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'night-pm-settings.json');
}

function migrateDiskV1(parsed: Record<string, unknown>): PersistedSettings {
  // Already in new shape
  if (parsed.claude && typeof (parsed.claude as Record<string, unknown>).authMode === 'string') {
    return deepMerge(
      DISK_DEFAULTS as unknown as Record<string, unknown>,
      parsed,
    ) as unknown as PersistedSettings;
  }

  const claude: Record<string, unknown> = {
    authMode: parsed.authMode ?? 'auto',
    vertexProjectId: parsed.vertexProjectId ?? '',
    vertexRegion: parsed.vertexRegion ?? 'global',
    model: parsed.claudeModel ?? '',
    permissionMode: parsed.defaultPermissionMode ?? 'bypassPermissions',
    effort: parsed.effort ?? 'high',
  };

  return deepMerge(DISK_DEFAULTS as Record<string, unknown>, {
    provider: parsed.provider ?? 'claude',
    claude,
    gemini: { model: (parsed.gemini as Record<string, unknown> | undefined)?.model ?? '' },
    codex: { model: (parsed.codex as Record<string, unknown> | undefined)?.model ?? '' },
    opencode: {
      provider: (parsed.opencode as Record<string, unknown> | undefined)?.provider ?? 'anthropic',
      model: (parsed.opencode as Record<string, unknown> | undefined)?.model ?? '',
    },
    maxTurns: parsed.maxTurns ?? 25,
    skills: parsed.skills ?? [],
    lastProjectPath: parsed.lastProjectPath ?? '',
    selectedProjectPath: parsed.selectedProjectPath ?? '',
    theme: (parsed.theme as 'light' | 'dark') ?? 'light',
  }) as unknown as PersistedSettings;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Loads persisted settings from disk (cached). Strips any secret keys found in the file (e.g. from old versions)
 * and rewrites the file without them so secrets do not persist on disk.
 * Does not read the keychain; use loadSettings() for full settings including secrets.
 */
function loadDiskSettings(): PersistedSettings {
  if (diskCached) return diskCached;
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    let hadSecrets = false;
    for (const key of ALL_SECRET_KEYS) {
      if (getByPath(parsed, key.split('.')) !== undefined) hadSecrets = true;
      deleteByPath(parsed, key.split('.'));
    }
    diskCached = migrateDiskV1(parsed);
    if (hadSecrets) {
      fs.writeFileSync(
        getSettingsPath(),
        JSON.stringify(diskCached, null, 2),
        'utf-8',
      );
    }
  } catch {
    diskCached = { ...DISK_DEFAULTS };
  }
  return diskCached;
}

/**
 * Merges the given partial persisted settings into current disk state and writes the result to the JSON file.
 * Updates the in-memory cache. Only non-secret fields should be passed.
 */
function saveDiskSettings(
  updatedSettings: Partial<PersistedSettings>,
): PersistedSettings {
  const current = loadDiskSettings();
  const merged = deepMerge(current, updatedSettings) as PersistedSettings;
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2), 'utf-8');
  diskCached = merged;
  return merged;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Loads full app settings: persisted JSON on disk merged with secrets from the keychain.
 * Use this whenever you need API keys or other secret values.
 */
export async function loadSettings(): Promise<AppSettings> {
  const persisted = loadDiskSettings();
  const secrets = await loadSecrets();
  return hydrateWithSecrets(persisted, secrets);
}

/**
 * Persists settings: non-secret fields are written to the JSON file, secret fields to the keychain.
 * Accepts partial settings; only provided keys are updated. Returns the full settings after save.
 */
export async function saveSettings(
  settings: Partial<AppSettings>,
): Promise<AppSettings> {
  const secretWritePromises: Promise<void>[] = [];
  for (const secretKey of ALL_SECRET_KEYS) {
    const secretValue = getByPath(settings, secretKey.split('.'));
    if (secretValue !== undefined) {
      secretWritePromises.push(setSecret(secretKey, String(secretValue)));
    }
  }
  await Promise.all(secretWritePromises);
  const toPersist = toDiskSafe(settings);
  saveDiskSettings(toPersist);
  return loadSettings();
}

/**
 * Synchronous load of persisted settings only (no keychain). Use when async is not possible (e.g. provider init).
 * Secrets are not included; use loadSettings() when API keys are needed.
 */
export function loadSettingsSync(): PersistedSettings {
  return loadDiskSettings();
}

export function getSetting<K extends keyof PersistedSettings>(
  key: K,
): PersistedSettings[K] {
  return loadDiskSettings()[key];
}
