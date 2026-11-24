// What `Open` does with a GridFS file, whose name is data from the database: the name of its temporary
// copy, and whether the desktop app hands it to the operating system.
import { describe, expect, it } from 'vitest';
import { openedFileName } from '../../src/gridfs';
import { opensAsData } from '../../src/shared/openable';

describe('opensAsData', () => {
  it('accepts documents and media that programs only read', () => {
    for (const name of ['report.pdf', 'photo.JPG', 'notes.txt', 'data.csv', 'doc.json', 'README.md', 'app.log', 'song.mp3', 'clip.mp4', '/tmp/x/a b.png', 'C:\\Temp\\x\\a.webp']) {
      expect(opensAsData(name), name).toBe(true);
    }
  });

  it('refuses what the operating system would run, or a program would run code from', () => {
    const refused = ['invoice.pdf.bat', 'setup.exe', 'link.lnk', 'app.desktop', 'page.hta', 'script.js', 'run.sh', 'x.ps1', 'x.cmd', 'x.vbs', 'x.jar', 'x.msi', 'x.scr', 'x.app', 'x.command', 'x.url'];
    const scripted = ['drawing.svg', 'page.html', 'page.htm', 'feed.xml', 'macro.docm', 'sheet.xlsx', 'text.docx', 'files.zip', 'files.tar.gz'];
    for (const name of [...refused, ...scripted]) expect(opensAsData(name), name).toBe(false);
  });

  it('refuses names without an extension, and those Windows would shorten', () => {
    for (const name of ['README', '.pdf', 'pdf', '', 'x.exe.', 'x.pdf.', 'x.pdf ', 'x.pdf::$DATA', 'dir.pdf/run', 'dir.pdf\\run.exe']) expect(opensAsData(name), name).toBe(false);
  });
});

describe('openedFileName', () => {
  it('keeps the name of the file, without folders', () => {
    expect(openedFileName('report.pdf')).toBe('report.pdf');
    expect(openedFileName('a b (1).txt')).toBe('a b (1).txt');
  });

  it('never names another folder', () => {
    expect(openedFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(openedFileName('a\\b:c')).toBe('a_b_c');
    expect(openedFileName('..')).toBe('file');
    expect(openedFileName('.')).toBe('file');
    expect(openedFileName('')).toBe('file');
    expect(openedFileName('a\u0000b\n.txt')).toBe('a_b_.txt');
  });
});
