import { describe, it, expect, afterEach } from 'vitest'
import { cleanPhotoUrl, isUploadThingHost, uploadThingAppId, PHOTO_URL_MAX } from '@/lib/photo-url'

const token = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')
const OURS = token({ apiKey: 'sk_live_x', appId: 'uq5g86ss41', regions: ['sea1'] })
const saved = process.env.UPLOADTHING_TOKEN
afterEach(() => {
  if (saved === undefined) delete process.env.UPLOADTHING_TOKEN
  else process.env.UPLOADTHING_TOKEN = saved
})

describe('cleanPhotoUrl — with our token', () => {
  it('keeps a file link on our app host only', () => {
    process.env.UPLOADTHING_TOKEN = OURS
    expect(cleanPhotoUrl('  https://uq5g86ss41.ufs.sh/f/abc123 ')).toBe('https://uq5g86ss41.ufs.sh/f/abc123')
    expect(cleanPhotoUrl('https://UQ5G86SS41.ufs.sh/f/abc123')).toBe('https://uq5g86ss41.ufs.sh/f/abc123')
    expect(cleanPhotoUrl('https://someoneelse.ufs.sh/f/abc123')).toBeNull() // another UploadThing app
    expect(cleanPhotoUrl('https://utfs.io/f/abc123')).toBeNull()            // our uploads never return this
  })

  it('no photo is null, not an error', () => {
    process.env.UPLOADTHING_TOKEN = OURS
    for (const v of [undefined, null, '', '   ', 42, {}, ['https://uq5g86ss41.ufs.sh/f/a']]) expect(cleanPhotoUrl(v)).toBeNull()
  })

  it('drops links to anywhere else', () => {
    process.env.UPLOADTHING_TOKEN = OURS
    for (const v of [
      'http://uq5g86ss41.ufs.sh/f/abc',             // not https
      'https://evil.com/f/abc',                      // another host
      'https://ufs.sh/f/abc',                        // bare suffix, no app
      'https://uq5g86ss41.ufs.sh.evil.com/f/abc',    // look-alike
      'https://user:pw@uq5g86ss41.ufs.sh/f/abc',     // credentials
      'https://uq5g86ss41.ufs.sh:8443/f/abc',        // odd port
      'https://uq5g86ss41.ufs.sh/x/abc',             // not a file path
      'https://uq5g86ss41.ufs.sh/f/',                // no key
      'javascript:alert(1)',
      'not a url',
    ]) expect(cleanPhotoUrl(v)).toBeNull()
  })

  it(`drops a link longer than ${PHOTO_URL_MAX} characters`, () => {
    process.env.UPLOADTHING_TOKEN = OURS
    expect(cleanPhotoUrl(`https://uq5g86ss41.ufs.sh/f/${'a'.repeat(PHOTO_URL_MAX)}`)).toBeNull()
  })
})

describe('uploadThingAppId', () => {
  it('reads the appId from the token', () => {
    process.env.UPLOADTHING_TOKEN = OURS
    expect(uploadThingAppId()).toBe('uq5g86ss41')
  })

  it.each([
    ['missing', undefined],
    ['not base64 json', 'definitely-not-a-token'],
    ['no appId', token({ apiKey: 'sk_x', regions: ['sea1'] })],
    ['odd appId', token({ appId: 'a.b/c' })],
  ])('is null when the token is %s', (_label, v) => {
    if (v === undefined) delete process.env.UPLOADTHING_TOKEN
    else process.env.UPLOADTHING_TOKEN = v
    expect(uploadThingAppId()).toBeNull()
  })
})

describe('fallback without a usable token (dev)', () => {
  it('accepts any <app>.ufs.sh host, nothing else', () => {
    delete process.env.UPLOADTHING_TOKEN
    expect(cleanPhotoUrl('https://anyapp.ufs.sh/f/abc')).toBe('https://anyapp.ufs.sh/f/abc')
    expect(cleanPhotoUrl('https://ufs.sh/f/abc')).toBeNull()
    expect(cleanPhotoUrl('https://app.ufs.sh.evil.com/f/abc')).toBeNull()
    expect(cleanPhotoUrl('https://a.b.ufs.sh/f/abc')).toBeNull()
    expect(cleanPhotoUrl('https://utfs.io/f/abc')).toBeNull()
  })

  it('host check', () => {
    expect(isUploadThingHost('abc.ufs.sh', null)).toBe(true)
    expect(isUploadThingHost('.ufs.sh', null)).toBe(false)
    expect(isUploadThingHost('example.com', null)).toBe(false)
    expect(isUploadThingHost('abc.ufs.sh', 'xyz')).toBe(false)
    expect(isUploadThingHost('XYZ.ufs.sh', 'xyz')).toBe(true)
  })
})
