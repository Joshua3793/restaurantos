import { describe, it, expect } from 'vitest'
import { buildApproveNote, noteReason } from '@/lib/invoice/approve-note'

const CILANTRO = {
  description: 'CILANTRO CLEAN WASH FRES', itemName: 'Cilantro',
  message: "Sysco's box for Cilantro is a case of 4 × 1 lb (1.81 kg). This line says 1 × 1 lb (454 g). Fix the case size, or receive the stock and keep the old price.",
}
const LIMES = {
  description: 'LIMES 48S', itemName: 'Limes',
  message: 'This line has no price. Enter the price, or receive the stock and keep the old price.',
}
const BISON = {
  description: 'BISON BURGER', itemName: 'Bison burger',
  message: "Price looks about 1,000× off — check the unit. This line works out at $25,000.00 per kg; Bison burger's box is $25.00 per kg.",
}

describe('noteReason — the decision message without its advice', () => {
  it('drops the "fix it, or receive" sentence and reads as one clause', () => {
    expect(noteReason(CILANTRO.message)).toBe("Sysco's box for Cilantro is a case of 4 × 1 lb (1.81 kg) and this line says 1 × 1 lb (454 g)")
  })
  it('lower-cases a leading "This line"', () => {
    expect(noteReason(LIMES.message)).toBe('this line has no price')
  })
  it('drops "— check the unit", keeps the two prices, lower-cases "Price"', () => {
    expect(noteReason(BISON.message)).toBe("price looks about 1,000× off and this line works out at $25,000.00 per kg; Bison burger's box is $25.00 per kg")
  })
})

describe('buildApproveNote', () => {
  it('says nothing (null) when every line went through', () => {
    expect(buildApproveNote({ receivedWithoutPrice: [], skippedPrice: [], skippedCreateNew: [], createNewNameRefused: false })).toBeNull()
  })

  it('one line received without a price change — singular, one closing sentence', () => {
    expect(buildApproveNote({ receivedWithoutPrice: [CILANTRO], skippedPrice: [], skippedCreateNew: [], createNewNameRefused: false })).toBe(
      "1 line was received without a price change: Cilantro — Sysco's box for Cilantro is a case of 4 × 1 lb (1.81 kg) and this line says 1 × 1 lb (454 g). " +
      'The stock is in; the price was left as it was.',
    )
  })

  it('two lines — plural, joined with a semicolon, one full stop each sentence', () => {
    expect(buildApproveNote({ receivedWithoutPrice: [CILANTRO, LIMES], skippedPrice: [], skippedCreateNew: [], createNewNameRefused: false })).toBe(
      "2 lines were received without a price change: Cilantro — Sysco's box for Cilantro is a case of 4 × 1 lb (1.81 kg) and this line says 1 × 1 lb (454 g); " +
      'Limes — this line has no price. The stock is in; the prices were left as they were.',
    )
  })

  it('names the line by its wording when it has no product', () => {
    expect(buildApproveNote({ receivedWithoutPrice: [{ ...LIMES, itemName: null }], skippedPrice: [], skippedCreateNew: [], createNewNameRefused: false }))
      .toMatch(/^1 line was received without a price change: LIMES 48S — this line has no price\./)
  })

  it('a line that could not even be received says so, singular and plural', () => {
    expect(buildApproveNote({ receivedWithoutPrice: [], skippedPrice: [LIMES], skippedCreateNew: [], createNewNameRefused: false })).toBe(
      '1 line was not received and its price was not changed: Limes — this line has no price.',
    )
    expect(buildApproveNote({ receivedWithoutPrice: [], skippedPrice: [LIMES, BISON], skippedCreateNew: [], createNewNameRefused: false })).toBe(
      '2 lines were not received and their prices were not changed: Limes — this line has no price; ' +
      "Bison burger — price looks about 1,000× off and this line works out at $25,000.00 per kg; Bison burger's box is $25.00 per kg.",
    )
  })

  it("keeps today's new-product sentence, one full stop, and the plain-name hint", () => {
    expect(buildApproveNote({
      receivedWithoutPrice: [], skippedPrice: [],
      skippedCreateNew: ['"OAT MILK" was never set up in the Add new product form'], createNewNameRefused: false,
    })).toBe('1 new product was not created — "OAT MILK" was never set up in the Add new product form. Delete this invoice and scan it again to create it.')
    expect(buildApproveNote({
      receivedWithoutPrice: [], skippedPrice: [],
      skippedCreateNew: ['"A": needs a name.', '"B": use a plain name.'], createNewNameRefused: true,
    })).toBe('2 new products were not created — "A": needs a name; "B": use a plain name. Delete this invoice and scan it again with a plain name.')
  })

  it('joins all three in order with single spaces', () => {
    const note = buildApproveNote({
      receivedWithoutPrice: [CILANTRO], skippedPrice: [LIMES],
      skippedCreateNew: ['"X" was never set up in the Add new product form'], createNewNameRefused: false,
    })!
    expect(note.indexOf('received without a price change')).toBeLessThan(note.indexOf('was not received'))
    expect(note.indexOf('was not received')).toBeLessThan(note.indexOf('new product'))
    expect(note).not.toMatch(/\.\./)
    expect(note).not.toMatch(/ {2}/)
  })
})
