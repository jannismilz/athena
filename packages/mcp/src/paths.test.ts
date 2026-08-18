import { describe, expect, test } from 'bun:test'
import { conversationPath, notePath, slugify } from './paths.ts'

const TZ = 'Europe/Berlin'
const AT = new Date(Date.UTC(2026, 7, 18, 22, 30)) // 00:30 the next day in Europe/Berlin

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    expect(slugify('DNS in the datacenter')).toBe('dns-in-the-datacenter')
  })

  test('transliterates umlauts instead of dropping them', () => {
    expect(slugify('Größe und Höhe')).toBe('groesse-und-hoehe')
    expect(slugify('Straße')).toBe('strasse')
  })

  test('strips punctuation and collapses separators', () => {
    expect(slugify('K8s: networking & DNS!!')).toBe('k8s-networking-dns')
  })

  test('never returns an empty or trailing-hyphen slug', () => {
    expect(slugify('!!!')).toBe('untitled')
    expect(slugify('')).toBe('untitled')
    expect(slugify('a'.repeat(200))).toHaveLength(60)
    expect(slugify(`${'a'.repeat(59)} b`).endsWith('-')).toBe(false)
  })
})

describe('generated paths', () => {
  test('conversations are filed by year and month', () => {
    expect(conversationPath('DNS chat', TZ, AT)).toBe('conversations/2026/08/19-dns-chat')
  })

  test('notes land in the inbox with a date prefix', () => {
    expect(notePath('Quick idea', TZ, AT)).toBe('inbox/2026-08-19-quick-idea')
  })

  test('the configured timezone decides the date, not the server', () => {
    expect(conversationPath('x', 'UTC', AT)).toBe('conversations/2026/08/18-x')
    expect(conversationPath('x', 'Europe/Berlin', AT)).toBe('conversations/2026/08/19-x')
  })
})
