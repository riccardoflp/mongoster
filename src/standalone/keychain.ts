// Whether the desktop app can encrypt its secrets with a key that the operating system keeps for the user
// (DPAPI, Keychain, a Linux keyring). No electron dependency: it is given Electron's `safeStorage`.

/** The part of Electron's `safeStorage` that says how it would encrypt. */
export interface Keychain {
  isEncryptionAvailable(): boolean;
  /** Linux only: `gnome_libsecret`, `kwallet`…, or `basic_text` when there is no keyring. */
  getSelectedStorageBackend?(): string;
}

/**
 * True when a secret encrypted now could be read back only through the system's keychain. On Linux without
 * a keyring Electron still says that encryption is available: it then encrypts with a key that is the same
 * on every machine (`basic_text`), which protects nothing, so that counts as no keychain.
 */
export function keychainEncrypts(keychain: Keychain, platform: string = process.platform): boolean {
  if (!keychain.isEncryptionAvailable()) return false;
  if (platform !== 'linux') return true;
  try {
    return keychain.getSelectedStorageBackend?.() !== 'basic_text';
  } catch {
    return false;
  }
}
