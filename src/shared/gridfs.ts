// GridFS helpers without dependencies: bucket names of a database and hex dumps of binary files.

/** Bucket names of a database: the prefixes having both X.files and X.chunks. */
export function bucketNames(collections: string[]): string[] {
  const names = new Set(collections);
  return collections
    .filter((c) => c.endsWith('.files') && names.has(`${c.slice(0, -'.files'.length)}.chunks`))
    .map((c) => c.slice(0, -'.files'.length))
    .sort((a, b) => a.localeCompare(b));
}

/** "00000000  89 50 4e 47 …  .PNG…" */
export function hexDump(data: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 16) {
    const row = [...data.subarray(i, i + 16)];
    const hex = row.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}
