import * as path from 'node:path';

export const app = {
  getAppPath: () => path.resolve(process.cwd()),
  getPath: (name: string) => {
    if (name === 'userData') return path.join(process.cwd(), '.test-userdata');
    return process.cwd();
  },
};

/** In tests we use a no-op “encryption” (plain Buffer) so keychain read/write works without real safeStorage. */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  decryptString: (buf: Buffer) =>
    buf.length > 0 ? buf.toString('utf-8') : '{}',
  encryptString: (plain: string) => Buffer.from(plain, 'utf-8'),
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
};

export const BrowserWindow = class {
  loadURL() {}
  on() {}
  webContents = { send: () => {} };
};
