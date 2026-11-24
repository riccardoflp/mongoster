// The names of the files and folders of a folder backup. A collection or database name is data from the
// server and may hold anything a path gives a meaning to (`/`, `\`, `..`, `:`, a name Windows reserves), so
// it is percent-encoded before it becomes part of a path, the way mongodump does it, and decoded when a
// backup is read. Backups written before the names were encoded hold them as they were: both are read.
// No vscode dependency.
import { createHash } from 'crypto';

/** The longest encoded name: with `.metadata.json.gz` after it the file name stays within 255 bytes (mongodump's limit). */
const MAX_NAME = 238;
/** How much of a longer name is kept, before `%24` and the 27 characters of its hash (mongodump's numbers). */
const TRUNCATED = 208;
/** The names Windows gives to devices, whatever follows their first dot: `con.bson` is the console there. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

const escaped = (byte: number) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
const nameHash = (name: string) => createHash('sha1').update(name, 'utf8').digest('base64url');

/**
 * The name of a collection or of a database as part of a file or folder name. Only letters, digits, `_`, `-`
 * and `.` are kept: every other byte is percent-encoded (`%` too, so that decoding gives the name back), and
 * so are a dot at either end and the first letter of a name reserved by Windows. The result never names a
 * parent folder or a device and is valid on every file system; mongorestore decodes it as it does mongodump's.
 */
export function backupFileName(name: string): string {
  let out = '';
  for (const byte of Buffer.from(name, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.-]/.test(char) ? char : escaped(byte);
  }
  if (out.startsWith('.')) out = `%2E${out.slice(1)}`;
  if (out.endsWith('.')) out = `${out.slice(0, -1)}%2E`;
  if (RESERVED.test(out)) out = escaped(out.charCodeAt(0)) + out.slice(1);
  if (out.length <= MAX_NAME) return out;
  // Like mongodump: the start of the name, `$` (encoded) and the hash of the whole name. The name itself is
  // then read from the collection's metadata. The cut never falls inside a %XX.
  let cut = TRUNCATED;
  if (out[cut - 1] === '%') cut -= 1;
  else if (out[cut - 2] === '%') cut -= 2;
  return `${out.slice(0, cut)}%24${nameHash(name)}`;
}

function decoded(fileName: string): string | undefined {
  try {
    return decodeURIComponent(fileName);
  } catch {
    return undefined;
  }
}

/**
 * The collection a backup's files are for, from their name without the extension and from the
 * `collectionName` of their metadata, when they have one. A name without `%` is the collection's. With `%`
 * the file may hold an encoded name (mongodump's, or Mongoster's) or, in a backup written before names were
 * encoded, a name that has a `%` of its own: the metadata tells which, and is the only place where a name
 * too long for a file is whole. Without metadata the name is decoded, as mongorestore does.
 */
export function backupCollectionName(fileName: string, metadataName?: string): string {
  if (!fileName.includes('%')) return fileName;
  const plain = decoded(fileName);
  if (metadataName !== undefined) {
    if (fileName === metadataName || plain === metadataName || backupFileName(metadataName) === fileName) return metadataName;
    // A truncated name written by mongodump, whose encoding of the kept part may differ from the one above.
    if (fileName.endsWith(`%24${nameHash(metadataName)}`)) return metadataName;
  }
  return plain ?? fileName;
}

/**
 * The database a backup's folder is for. Folders have no metadata, so a name is decoded only when it is
 * exactly what `backupFileName` writes: a folder of mongodump, or of an earlier backup, keeps its name.
 */
export function backupDatabaseName(folderName: string): string {
  if (!folderName.includes('%')) return folderName;
  const plain = decoded(folderName);
  return plain !== undefined && backupFileName(plain) === folderName ? plain : folderName;
}
