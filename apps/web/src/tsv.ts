/**
 * Parses clipboard text from Excel / Google Sheets into rows of cells.
 * Tabs split cells, newlines split rows, and "quoted" cells may contain tabs, newlines and "" escapes.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let atCellStart = true;
  while (i < text.length) {
    const ch = text[i]!;
    if (atCellStart && ch === '"') {
      // Quoted cell: read until the closing quote.
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cell += text[i++];
      }
      atCellStart = false;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      atCellStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
    } else {
      cell += ch;
      atCellStart = false;
    }
    i++;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** True when clipboard text spans more than one cell (and so belongs in the grid, not one cell's editor). */
export const isMultiCell = (text: string): boolean => /[\t\n\r]/.test(text.replace(/[\r\n]+$/, ''));
