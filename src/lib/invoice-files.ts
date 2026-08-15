// Loads an InvoiceFile's bytes whether it lives on the CDN (https URL) or in
// the DB via the local-upload fallback (data: URI).
export async function loadBuffer(file: { fileUrl: string; fileName: string }): Promise<Buffer> {
  if (file.fileUrl.startsWith('data:')) {
    const comma = file.fileUrl.indexOf(',')
    return Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
  }
  const res = await fetch(file.fileUrl)
  if (!res.ok) throw new Error(`Failed to fetch ${file.fileName}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
