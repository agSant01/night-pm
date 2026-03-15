import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getSetting,
  loadSettingsSync,
  saveSettings
} from '../main/settings';

const userDataDir = path.join(process.cwd(), '.test-userdata');
const settingsPath = path.join(userDataDir, 'night-pm-settings.json');

function removeSettingsFile(): void {
  try {
    fs.unlinkSync(settingsPath);
  } catch {
    // ignore if missing
  }
}

function readSettingsFile(): string {
  return fs.readFileSync(settingsPath, 'utf-8');
}

describe('settings', () => {
  beforeAll(() => {
    // create test user data directory
    fs.mkdirSync(userDataDir, { recursive: true });
  });

  beforeEach(() => {
    // clear settings cache
    vi.resetModules();
    removeSettingsFile();
  });

  afterAll(() => {
    // clean up test user data directory
    fs.rmSync(userDataDir, { recursive: true });
  });

  describe('loadSettingsSync', () => {
    it('returns default persisted shape when no file exists', async () => {
      const { loadSettingsSync } = await import('../main/settings');
      const got = loadSettingsSync();
      expect(got.theme).toBe('light');
      expect(got.provider).toBe('');
      expect(got.maxTurns).toBe(25);
      expect(got.claude.authMode).toBe('auto');
      expect(got.claude.model).toBe('');
      expect(got.gemini.model).toBe('');
      expect(got.remoteSync.s3.endpointUrl).toBe('');
      expect('anthropicApiKey' in got.claude).toBe(false);
      expect('apiKey' in got.gemini).toBe(false);
    });

    it('returns merged settings after saveSettings (partial update)', async () => {
      await saveSettings({ theme: 'dark' });
      const got = loadSettingsSync();
      expect(got.theme).toBe('dark');
      expect(got.maxTurns).toBe(25);
    });

    it('merges multiple partial updates', async () => {
      await saveSettings({ theme: 'dark', maxTurns: 10 });
      await saveSettings({ lastProjectPath: '/some/project' });
      const got = loadSettingsSync();
      expect(got.theme).toBe('dark');
      expect(got.maxTurns).toBe(10);
      expect(got.lastProjectPath).toBe('/some/project');
    });
  });

  describe('getSetting', () => {
    it('returns value for a single key', async () => {
      await saveSettings({ theme: 'dark' });
      expect(getSetting('theme')).toBe('dark');
    });

    it('returns default when key not yet set', async () => {
      const { getSetting: getSettingFresh } = await import('../main/settings');
      expect(getSettingFresh('theme')).toBe('light');
      expect(getSettingFresh('maxTurns')).toBe(25);
    });
  });

  describe('loadSettings', () => {
    it('returns full AppSettings with secret keys from keychain', async () => {
      const { loadSettings } = await import('../main/settings');
      const got = await loadSettings();
      expect(got.theme).toBe('light');
      expect(got.claude).toHaveProperty('anthropicApiKey');
      expect(got.gemini).toHaveProperty('apiKey');
      expect(got.remoteSync.s3).toHaveProperty('accessKeyId');
      expect(got.remoteSync.s3).toHaveProperty('secretAccessKey');
      expect(typeof got.claude.anthropicApiKey).toBe('string');
      expect(typeof got.gemini.apiKey).toBe('string');
    });

    it('includes persisted values and keychain secrets together', async () => {
      const { saveSettings, loadSettings } = await import('../main/settings');
      await saveSettings({ theme: 'dark' });
      const got = await loadSettings();
      expect(got.theme).toBe('dark');
      expect(got.claude).toHaveProperty('anthropicApiKey');
    });
  });

  describe('saveSettings', () => {
    it('does not write secret keys to the JSON file', async () => {
      await saveSettings({
        theme: 'dark',
        claude: { anthropicApiKey: 'sk-secret-123' },
      } as Parameters<typeof saveSettings>[0]);
      const raw = readSettingsFile();
      const parsed = JSON.parse(raw);
      console.log(parsed);
      expect(parsed.theme).toBe('dark');
      expect(parsed.claude).not.toHaveProperty('anthropicApiKey');
      expect(raw).not.toContain('sk-secret-123');
    });

    it('returns full settings after save', async () => {
      const { saveSettings } = await import('../main/settings');
      const result = await saveSettings({ theme: 'dark' });
      expect(result.theme).toBe('dark');
      expect(result.claude).toHaveProperty('anthropicApiKey');
      expect(result.maxTurns).toBe(25);
    });
  });

  describe('round-trip', () => {
    it('persists and reloads non-secret fields from disk', async () => {
      await saveSettings({
        theme: 'dark',
        maxTurns: 12,
        lastProjectPath: '/foo',
        claude: { model: 'claude-3-5-sonnet' },
      } as Parameters<typeof saveSettings>[0]);
      const got = loadSettingsSync();
      expect(got.theme).toBe('dark');
      expect(got.maxTurns).toBe(12);
      expect(got.lastProjectPath).toBe('/foo');
      expect(got.claude.model).toBe('claude-3-5-sonnet');
    });
  });

  describe('migration (legacy format)', () => {
    it('migrates old flat shape to new nested shape', async () => {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          provider: 'claude',
          authMode: 'auto',
          vertexProjectId: 'proj',
          vertexRegion: 'us-east1',
          claudeModel: 'claude-3-opus',
          defaultPermissionMode: 'bypassPermissions',
          effort: 'low',
          theme: 'dark',
          maxTurns: 10,
        }),
        'utf-8',
      );
      const { loadSettingsSync } = await import('../main/settings');
      const got = loadSettingsSync();
      expect(got.provider).toBe('claude');
      expect(got.theme).toBe('dark');
      expect(got.maxTurns).toBe(10);
      expect(got.claude.authMode).toBe('auto');
      expect(got.claude.vertexProjectId).toBe('proj');
      expect(got.claude.vertexRegion).toBe('us-east1');
      expect(got.claude.model).toBe('claude-3-opus');
      expect(got.claude.permissionMode).toBe('bypassPermissions');
      expect(got.claude.effort).toBe('low');
    });

    it('strips secret keys from in-memory result and clears them from file', async () => {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          provider: 'claude',
          claude: { authMode: 'auto', anthropicApiKey: 'leaked-key' },
          gemini: { model: '', apiKey: 'also-leaked' },
          remoteSync: {
            s3: {
              endpointUrl: '',
              bucket: '',
              region: '',
              accessKeyId: 'leaked-key',
              secretAccessKey: 'also-leaked',
            },
          },
          opencode: { provider: 'anthropic', model: '', apiKey: 'leaked-key' },
        }),
        'utf-8',
      );
      vi.resetModules();
      const { loadSettingsSync } = await import('../main/settings');
      const got = loadSettingsSync();
      expect(got.claude).not.toHaveProperty('anthropicApiKey');
      expect(got.gemini).not.toHaveProperty('apiKey');
      const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(onDisk.claude).not.toHaveProperty('anthropicApiKey');
      expect(onDisk.gemini).not.toHaveProperty('apiKey');
    });

    it('rewrites settings file without secrets when file contained them', async () => {
      vi.resetModules();
      fs.mkdirSync(userDataDir, { recursive: true });
      const withSecrets = {
        provider: 'claude',
        theme: 'dark',
        claude: { authMode: 'auto', anthropicApiKey: 'leaked-key' },
        gemini: { model: '', apiKey: 'also-leaked' },
      };
      fs.writeFileSync(settingsPath, JSON.stringify(withSecrets), 'utf-8');
      const { loadSettingsSync } = await import('../main/settings');
      loadSettingsSync();
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      expect(raw).not.toContain('leaked-key');
      expect(raw).not.toContain('also-leaked');
      expect(raw).not.toContain('anthropicApiKey');
      expect(raw).not.toContain('"apiKey"');
      const onDisk = JSON.parse(raw);
      expect(onDisk.provider).toBe('claude');
      expect(onDisk.theme).toBe('dark');
      expect(onDisk.claude.authMode).toBe('auto');
    });
  });
});
