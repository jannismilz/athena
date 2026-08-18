import { expect, test } from 'bun:test'
import { pointId } from './qdrant.ts'

test('point ids are deterministic and readable', () => {
  expect(pointId(42, 3)).toBe(4_200_003)
  expect(pointId(42, 3)).toBe(pointId(42, 3))
})

test('point ids never collide across pages or chunks', () => {
  const ids = new Set<number>()
  for (let page = 1; page <= 50; page++) {
    for (let chunk = 0; chunk < 40; chunk++) ids.add(pointId(page, chunk))
  }
  expect(ids.size).toBe(50 * 40)
})

test('an absurd chunk count fails loudly instead of silently colliding', () => {
  expect(() => pointId(1, 100_000)).toThrow(/more than/)
})
