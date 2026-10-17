// Recipe Scan: turn Word and Excel files into plain text for the reader.
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'

export async function docxToText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf })
  return value
}

/** Every sheet as CSV under a "## <sheet name>" header, in workbook order. */
export function sheetToText(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: 'buffer' })
  return wb.SheetNames
    .map(n => `## ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n]).trim()}`)
    .join('\n\n')
}
