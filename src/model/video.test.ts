import { expect, test } from 'vitest'
import { newProject } from './defaults'
import type { Item, Media } from './types'
import { validVideoTrack, videoEnd, videoTimeAt } from './video'

const media: Record<string, Media> = { m: { id: 'm', name: 'a', durationF: 600 } }
const it = (id: string, start: number, trimIn: number, trimOut: number): Item => ({ id, refId: 'm', start, trimIn, trimOut })

test('videoTimeAt maps frame to media seconds with trims', () => {
  const p = newProject()
  p.media = [media.m]
  p.sequence.tracks.unshift({ id: 'v', kind: 'video', hidden: false, locked: false, items: [it('i', 120, 60, 300)] })
  expect(videoTimeAt(p, 119)).toBeNull()
  expect(videoTimeAt(p, 120)).toEqual({ mediaId: 'm', itemId: 'i', seconds: 1.2 })
  expect(videoTimeAt(p, 359)?.seconds).toBeCloseTo(299 / 50)
  expect(videoTimeAt(p, 360)).toBeNull()
  expect(videoTimeAt(newProject(), 0)).toBeNull()
})

test('validVideoTrack rejects overlap, over-length trim, unknown media', () => {
  expect(validVideoTrack([it('a', 0, 0, 100), it('b', 100, 0, 50)], media)).toBe(true)
  expect(validVideoTrack([it('a', 0, 0, 100), it('b', 99, 0, 50)], media)).toBe(false)
  expect(validVideoTrack([it('a', 0, 0, 601)], media)).toBe(false)
  expect(validVideoTrack([it('a', 0, 5, 5)], media)).toBe(false)
  expect(validVideoTrack([it('a', -1, 0, 5)], media)).toBe(false)
  expect(validVideoTrack([{ ...it('a', 0, 0, 5), refId: 'x' }], media)).toBe(false)
})

test('videoEnd: 0 without V1 items, else end of the last item', () => {
  const p = newProject()
  expect(videoEnd(p)).toBe(0)
  p.media = [{ id: 'm', name: 'a', durationF: 600 }]
  p.sequence.tracks.unshift({ id: 'v', kind: 'video', hidden: false, locked: false, items: [
    { id: 'a', refId: 'm', start: 300, trimIn: 0, trimOut: 100 },
    { id: 'b', refId: 'm', start: 0, trimIn: 50, trimOut: 250 },
  ] })
  expect(videoEnd(p)).toBe(400)
})
