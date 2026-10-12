import { describe, expect, it } from 'vitest';
import { isMultiCell, parseTsv } from './tsv.ts';

describe('parseTsv', () => {
  it('splits tabs and newlines, ignoring the trailing newline Excel adds', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('keeps empty cells', () => {
    expect(parseTsv('a\t\tc\n\tb')).toEqual([['a', '', 'c'], ['', 'b']]);
  });
  it('reads quoted cells with newlines, tabs and escaped quotes', () => {
    expect(parseTsv('"line 1\nline 2"\t"say ""hi"""\n"x\ty"\tz')).toEqual([
      ['line 1\nline 2', 'say "hi"'],
      ['x\ty', 'z'],
    ]);
  });
});

describe('isMultiCell', () => {
  it('tells one cell from a block', () => {
    expect(isMultiCell('hello\r\n')).toBe(false);
    expect(isMultiCell('a\tb')).toBe(true);
    expect(isMultiCell('a\nb')).toBe(true);
  });
});
