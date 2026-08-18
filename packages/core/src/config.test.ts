import { describe, expect, test } from 'bun:test'
import { httpsOrigin, indexerSchema, loadConfig, toOrigin } from './config.ts'

describe('httpsOrigin', () => {
  test('accepts a bare https origin', () => {
    expect(httpsOrigin.safeParse('https://athena-mcp.example.com').success).toBe(true)
    expect(httpsOrigin.safeParse('https://athena-mcp.example.com/').success).toBe(true)
  })

  test('rejects http, paths, queries and fragments', () => {
    for (const bad of [
      'http://athena-mcp.example.com',
      'https://athena-mcp.example.com/mcp',
      'https://athena-mcp.example.com?a=1',
      'https://athena-mcp.example.com#x',
      'not-a-url',
    ]) {
      expect(httpsOrigin.safeParse(bad).success).toBe(false)
    }
  })
})

test('toOrigin normalises away the trailing slash', () => {
  expect(toOrigin('https://a.example.com/')).toBe('https://a.example.com')
})

describe('loadConfig', () => {
  const valid = {
    WIKI_API_TOKEN: 'token',
    POSTGRES_PASSWORD: 'pw',
    INDEX_INTERVAL_SECONDS: '600',
  }

  test('applies defaults and coerces numbers', () => {
    const cfg = loadConfig(indexerSchema, valid)
    expect(cfg.indexIntervalSeconds).toBe(600)
    expect(cfg.port).toBe(8081)
    expect(cfg.chunkMaxChars).toBe(1200)
    expect(cfg.tz).toBe('UTC')
  })

  test('treats an empty string as unset so defaults still apply', () => {
    expect(loadConfig(indexerSchema, { ...valid, WIKI_LOCALE: '' }).wikiLocale).toBe('en')
  })
})
