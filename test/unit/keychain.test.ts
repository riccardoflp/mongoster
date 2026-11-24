// When the desktop app's secrets are really encrypted (RS41).
import { describe, expect, it } from 'vitest';
import { keychainEncrypts } from '../../src/standalone/keychain';

describe('keychainEncrypts', () => {
  const keychain = (available: boolean, backend?: string) => ({ isEncryptionAvailable: () => available, ...(backend !== undefined && { getSelectedStorageBackend: () => backend }) });

  it('follows Electron on Windows and macOS', () => {
    expect(keychainEncrypts(keychain(true), 'win32')).toBe(true);
    expect(keychainEncrypts(keychain(true), 'darwin')).toBe(true);
    expect(keychainEncrypts(keychain(false), 'darwin')).toBe(false);
  });

  it('counts the fixed key of a Linux session without a keyring as no keychain', () => {
    expect(keychainEncrypts(keychain(true, 'gnome_libsecret'), 'linux')).toBe(true);
    expect(keychainEncrypts(keychain(true, 'kwallet6'), 'linux')).toBe(true);
    expect(keychainEncrypts(keychain(true, 'basic_text'), 'linux')).toBe(false);
    expect(keychainEncrypts(keychain(false, 'gnome_libsecret'), 'linux')).toBe(false);
    expect(keychainEncrypts({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => { throw new Error('not ready'); } }, 'linux')).toBe(false);
  });
});
