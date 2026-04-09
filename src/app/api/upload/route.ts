import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'

const UPLOAD_PROVIDER = process.env.UPLOAD_PROVIDER || 'local'

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  if (UPLOAD_PROVIDER === 'local') {
    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'invoices')
    await mkdir(uploadDir, { recursive: true })
    const buffer = Buffer.from(await file.arrayBuffer())
    const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    await writeFile(path.join(uploadDir, filename), buffer)
    return NextResponse.json({ url: `/uploads/invoices/${filename}` })
  }

  return NextResponse.json({ error: 'Upload provider not configured' }, { status: 500 })
}
