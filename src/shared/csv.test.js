import { describe, expect, it } from 'vitest'
import { csvCell, parseCsv, parseCsvRecords, toCsv } from './csv.js'

describe('CSV parser', () => {
  it('reads quoted fields with commas, doubled quotes, and line breaks', () => {
    const text = 'Name,Note\r\n"Example, Ada","She said ""yes""\nthen left"\r\nBen,plain\r\n'
    expect(parseCsv(text)).toEqual([
      ['Name', 'Note'],
      ['Example, Ada', 'She said "yes"\nthen left'],
      ['Ben', 'plain'],
    ])
  })

  it('removes a byte order mark, accepts LF rows, and drops blank lines', () => {
    expect(parseCsv('﻿a,b\n\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('keeps empty fields and a last row without a line break', () => {
    expect(parseCsv('a,,c\n,,\n"",x')).toEqual([['a', '', 'c'], ['', '', ''], ['', 'x']])
  })

  it('finds a header below notes and maps records by header', () => {
    const text = 'Notes:\n"Some text"\n\nFirst Name,Company\nAda, Northwind \n'
    const records = parseCsvRecords(text, { findHeader: row => row.includes('First Name') })
    expect(records).toEqual([{ 'First Name': 'Ada', Company: 'Northwind' }])
  })
})

describe('CSV writer', () => {
  it('quotes every cell and neutralizes spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`)
    expect(csvCell(' +1')).toBe(`"' +1"`)
    expect(csvCell('@cmd')).toBe(`"'@cmd"`)
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('""')
    expect(toCsv([['a', 1], ['b,c', '']])).toBe('"a","1"\r\n"b,c",""\r\n')
  })

  it('round-trips through the parser', () => {
    const rows = [['Company', 'Next step'], ['Northwind, Ltd', 'Line one\nLine two "quoted"']]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })
})
