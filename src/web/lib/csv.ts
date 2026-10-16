// CSV for spreadsheets, and saving a file from the browser.
//
// toCSV writes RFC 4180: a field is quoted when it holds a comma, a double quote, a line break
// or edge spaces, and quotes inside it are doubled; records end with CRLF. It starts with a
// UTF-8 byte order mark, so Excel opens Chinese text correctly instead of guessing a code page.
// It never changes the text itself: guarding cells that start with = + - @ (formula injection)
// is the caller's job, because a cell like "-333" must stay a number.
//
// parseCSV reads the same format back: quoted fields with commas and line breaks, doubled
// quotes, CRLF, LF or lone CR line ends, and a leading byte order mark. It is lenient with
// sloppy files: a quote inside an unquoted field is kept as a character, text after a closing
// quote is kept, and an unterminated quote runs to the end of the text.

/** U+FEFF: tells Excel the file is UTF-8. */
export const BOM = '\uFEFF';

export type CSVCell = string | number | null | undefined;

export interface ToCSVOptions {
  /** Start with the UTF-8 byte order mark (default true, for Excel). */
  bom?: boolean;
  /** Field separator (default a comma). */
  delimiter?: string;
}

/** One field, quoted when it has to be. Numbers are written as plain digits; NaN and Infinity as empty. */
export function csvField(value: CSVCell, delimiter = ','): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  const quote = s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s);
  return quote ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Rows to CSV text: CRLF after every record, a byte order mark first (see ToCSVOptions). */
export function toCSV(rows: readonly (readonly CSVCell[])[], opts: ToCSVOptions = {}): string {
  const delimiter = opts.delimiter ?? ',';
  const body = rows.map(row => row.map(cell => csvField(cell, delimiter)).join(delimiter) + '\r\n').join('');
  return (opts.bom ?? true) ? BOM + body : body;
}

/** CSV text to rows of fields (all strings). A final line break does not add an empty record. */
export function parseCSV(text: string, delimiter = ','): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  /** The current field began with a quote (so "" is an empty field, not nothing). */
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = '';
    quoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '' && !quoted) {
      inQuotes = true;
      quoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r') {
      if (s[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || quoted || row.length > 0) endRow();
  return rows;
}

/**
 * Save content as a file: a download on computers, the share or save prompt on iPhone.
 * `mime` should carry the charset for text, e.g. 'text/csv;charset=utf-8'.
 */
export function downloadFile(name: string, mime: string, content: BlobPart): void {
  if (typeof document === 'undefined') return;
  const blob = content instanceof Blob && (!mime || content.type === mime) ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // iOS reads the blob after the click returns; give it time before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
