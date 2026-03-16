import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SecretKey } from './keychain';
import { ALL_SECRET_KEYS, loadSecrets, setSecret } from './keychain';
import type { ProviderId } from './providers/types';

// ─── Secret path helpers (single place for "what is a secret" + where it lives) ───
// SecretKey is the path as string, e.g. 'claude.anthropicApiKey' → ['claude', 'anthropicApiKey']
// Precompute segments once so we don't repeat key.split('.') in strip/hydrate/save.
const SECRET_KEYS_AND_SEGMENTS: ReadonlyArray<{ key: SecretKey; segments: string[] }> =
  ALL_SECRET_KEYS.map((key) => ({ key, segments: key.split('.') }));

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
export function getByPath(
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
export function deleteByPath(
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
 * Sets a value at a nested path, creating intermediate objects as needed.
 * @param obj - Target object (mutated)
 * @param pathSegments - Dot-split path, e.g. `['claude', 'anthropicApiKey']`
 * @param value - Value to set at the leaf
 */
export function setByPath(
  obj: Record<string, unknown>,
  pathSegments: string[],
  value: unknown,
): void {
  if (pathSegments.length === 0) return;
  if (pathSegments.length === 1) {
    obj[pathSegments[0]] = value;
    return;
  }
  const key = pathSegments[0];
  let nested = obj[key];
  if (!isPlainObject(nested)) {
    nested = {};
    obj[key] = nested;
  }
  setByPath(nested as Record<string, unknown>, pathSegments.slice(1), value);
}

/**
 * Removes every secret key (ALL_SECRET_KEYS) from obj in place.
 * @returns true if any secret was present (caller may want to rewrite file)
 */
function stripSecretsInPlace(obj: Record<string, unknown>): boolean {
  let hadSecrets = false;
  for (const { segments } of SECRET_KEYS_AND_SEGMENTS) {
    if (getByPath(obj, segments) !== undefined) hadSecrets = true;
    deleteByPath(obj, segments);
  }
  return hadSecrets;
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

export interface RemoteSyncSettings {
  s3: {
    endpointUrl: string;
    bucket: string;
    region: string;
    accessKeyId: string; // loaded from keychain at runtime, never saved to disk
    secretAccessKey: string; // loaded from keychain at runtime, never saved to disk
    keyPrefix: string;
  };
}

export interface AppSettings {
  provider: ProviderId;

  claude: ClaudeSettings;
  gemini: GeminiSettings;
  codex: CodexSettings;
  opencode: OpenCodeSettings;

  remoteSync: RemoteSyncSettings;

  maxTurns: number;
  skills: string[];
  lastProjectPath: string;
  selectedProjectPath: string;
  theme: 'light' | 'dark';
}

// What actually gets written to / read from the JSON file on disk.
// API keys are deliberately absent — they live in the OS keychain.
//
// When adding a new secret: (1) Add key to keychain ALL_SECRET_KEYS
// (2) Add field to the right *Settings interface (e.g. ClaudeSettings)
// (3) Add Omit in PersistedSettings for that provider (4) Add to DISK_DEFAULTS (no secret value)
type PersistedSettings = Omit<AppSettings,
  'claude' | 'gemini' | 'codex' | 'opencode' | 'remoteSync'
> & {
  claude: Omit<ClaudeSettings, 'anthropicApiKey'>;
  gemini: Omit<GeminiSettings, 'apiKey'>;
  codex: Omit<CodexSettings, 'apiKey'>;
  opencode: Omit<OpenCodeSettings, 'apiKey'>;
  remoteSync: {
    s3: Omit<RemoteSyncSettings['s3'], 'accessKeyId' | 'secretAccessKey'>
  };
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
  remoteSync: {
    s3: {
      endpointUrl: '',
      bucket: '',
      region: '',
      keyPrefix: '',
    },
  },
};

let diskCached: PersistedSettings | null = null;

/** Path to the JSON settings file in the app userData directory. */
function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'night-pm-settings.json');
}

/** Writes settings object to disk (JSON, pretty-printed). */
function writeSettingsFile(data: Record<string, unknown>): void {
  fs.writeFileSync(
    getSettingsPath(),
    JSON.stringify(data, null, 2),
    'utf-8',
  );
}

/** Migrates disk settings from legacy v1 format to the current v2 format. */
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

/** Deep-merges source into target. Arrays and primitives are replaced, not merged. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
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
    const hadSecrets = stripSecretsInPlace(parsed);
    diskCached = migrateDiskV1(parsed);
    if (hadSecrets) writeSettingsFile(diskCached as unknown as Record<string, unknown>);
  } catch {
    diskCached = structuredClone(DISK_DEFAULTS);
  }
  return diskCached;
}

/**
 * Merges the given partial persisted settings into current disk state and writes the result to the JSON file.
 * Strips secret keys from the merged result before writing so they are never persisted.
 * Updates the in-memory cache. Only non-secret fields should be passed.
 */
function saveDiskSettings(
  updatedSettings: Partial<PersistedSettings>,
): PersistedSettings {
  const current = loadDiskSettings();
  const toWrite = deepMerge(current, updatedSettings) as PersistedSettings;
  stripSecretsInPlace(toWrite);
  writeSettingsFile(toWrite as unknown as Record<string, unknown>);
  diskCached = toWrite;
  return toWrite;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Loads full app settings: persisted JSON on disk merged with secrets from the keychain.
 * Use this whenever you need API keys or other secret values.
 */
export async function loadSettings(): Promise<AppSettings> {
  const persisted = loadDiskSettings();
  const secrets = await loadSecrets();
  const result = structuredClone(persisted) as Record<string, unknown>;
  // Inject each secret at the path implied by its key
  //   (e.g. `claude.anthropicApiKey` → `result.claude.anthropicApiKey`).
  for (const { key, segments } of SECRET_KEYS_AND_SEGMENTS) {
    setByPath(result, segments, secrets[key] ?? '');
  }
  return result as unknown as AppSettings;
}

/**
 * Persists settings: non-secret fields are written to the JSON file, secret fields to the keychain.
 * Accepts partial settings; only provided keys are updated. Returns the full settings after save.
 */
export async function saveSettings(
  settings: Partial<AppSettings>,
): Promise<AppSettings> {
  const secretWritePromises: Promise<void>[] = [];
  for (const { key, segments } of SECRET_KEYS_AND_SEGMENTS) {
    const secretValue = getByPath(settings, segments);
    if (secretValue !== undefined) {
      secretWritePromises.push(setSecret(key, String(secretValue)));
    }
  }
  await Promise.all(secretWritePromises);
  saveDiskSettings(settings);
  return loadSettings();
}

/**
 * Synchronous load of persisted settings only (no keychain).
 * Use when async is not possible (e.g. provider init).
 * Secrets are not included; use loadSettings() when API keys are needed.
 */
export function loadSettingsSync(): PersistedSettings {
  return loadDiskSettings();
}

/**
 * Only persisted settings are returned, not secrets.
 * @param key - The key of the setting to get
 * @returns The value of the setting
 */
export function getSetting<K extends keyof PersistedSettings>(
  key: K,
): PersistedSettings[K] {
  return loadDiskSettings()[key];
}
