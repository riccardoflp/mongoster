// Which files the desktop app hands to the operating system to be opened. Opening a file there means
// running the program registered for its extension, and for many extensions that program runs the file
// itself (.exe, .bat, .lnk, .desktop, .js, .hta…) or code inside it (macros in office documents, scripts in
// .svg and .html pages). A file's name may come from a database (a GridFS file), so only the types below
// are opened; the others are shown in their folder, for the user to decide.

/**
 * Extensions of documents and media that programs open as data: the short list of what is worth opening
 * with a click. Not on it, on purpose: everything executable or scripted, .svg, .html and .xml (opened by a
 * browser, they run scripts), office formats (macros), archives (their content is unknown). A type that is
 * missing costs one more click in the folder; a wrong type here runs code from a database.
 */
const OPENED_AS_DATA = new Set([
  ...['pdf', 'txt', 'log', 'md', 'csv', 'tsv', 'json'],
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic'],
  ...['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'],
  ...['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg'],
]);

/**
 * Whether the file with this name or path can be opened with the operating system's program for it. Only
 * the last extension counts (`invoice.pdf.bat` is a .bat), and a name that ends with a dot or a space is
 * refused: Windows drops them, so `x.exe.` would be opened as `x.exe`.
 */
export function opensAsData(file: string): boolean {
  const name = file.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return OPENED_AS_DATA.has(name.slice(dot + 1).toLowerCase());
}
