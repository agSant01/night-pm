import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Single source of truth for all keychain keys; add new secrets here only. */
export const ALL_SECRET_KEYS = [
  'claude.anthropicApiKey',
  'gemini.apiKey',
  'codex.apiKey',
  'opencode.apiKey',
] as const;

export type SecretKey = (typeof ALL_SECRET_KEYS)[number];

function getSecretsPath(): string {
  return path.join(app.getPath('userData'), 'night-pm-secrets.enc');
}

function loadStore(): Record<string, string> {
  try {
    const buf = fs.readFileSync(getSecretsPath());
    if (!safeStorage.isEncryptionAvailable()) return {};
    const decrypted = safeStorage.decryptString(buf);
    return JSON.parse(decrypted);
  } catch {
    return {};
  }
}

function saveStore(store: Record<string, string>): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  const encrypted = safeStorage.encryptString(JSON.stringify(store));
  fs.writeFileSync(getSecretsPath(), encrypted);
}

export async function getSecret(key: SecretKey): Promise<string> {
  try {
    return loadStore()[key] ?? '';
  } catch {
    return '';
  }
}

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  try {
    const store = loadStore();
    if (value) {
      store[key] = value;
    } else {
      delete store[key];
    }
    saveStore(store);
  } catch (err) {
    console.error(`[keychain] Failed to set ${key}:`, err);
  }
}

export async function deleteSecret(key: SecretKey): Promise<void> {
  try {
    const store = loadStore();
    delete store[key];
    saveStore(store);
  } catch {
    // Already gone — fine
  }
}

export async function clearAllSecrets(): Promise<void> {
  await Promise.all(ALL_SECRET_KEYS.map(deleteSecret));
}

export async function loadSecrets(): Promise<Record<SecretKey, string>> {
  const values = await Promise.all(ALL_SECRET_KEYS.map((k) => getSecret(k)));
  return Object.fromEntries(
    ALL_SECRET_KEYS.map((k, i) => [k, values[i]]),
  ) as Record<SecretKey, string>;
}
