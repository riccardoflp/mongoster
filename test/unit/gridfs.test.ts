import { describe, expect, it } from 'vitest';
import { bucketNames, hexDump } from '../../src/shared/gridfs';

describe('bucketNames', () => {
  it('keeps the prefixes that have both .files and .chunks, sorted', () => {
    expect(bucketNames(['users', 'fs.files', 'fs.chunks', 'photos.chunks', 'photos.files', 'orphan.files', 'other.chunks'])).toEqual(['fs', 'photos']);
  });

  it('handles prefixes with dots', () => {
    expect(bucketNames(['a.b.files', 'a.b.chunks'])).toEqual(['a.b']);
    expect(bucketNames([])).toEqual([]);
  });
});

describe('hexDump', () => {
  it('shows offsets, 16 bytes per line and their printable characters', () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 14 }, (_, i) => 0x61 + i)]);
    const lines = hexDump(data).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('00000000  89 50 4e 47 61 62 63 64 65 66 67 68 69 6a 6b 6c  .PNGabcdefghijkl');
    // A short last line keeps the ASCII column aligned.
    expect(lines[1]).toBe(`00000010  6d 6e${' '.repeat(42)}  mn`);
  });

  it('is empty for no data', () => {
    expect(hexDump(new Uint8Array())).toBe('');
  });
});
