import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addBlockedDiagnostic,
  filterPlayableSources,
} from '../../src/playability/filter.ts'

beforeEach(() => {
  // probes are disabled under NODE_ENV=test — opt back in for these tests
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('INTERNAL_DEBUG', 'false')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function stubUpstream(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      for (const [key, make] of Object.entries(routes)) {
        if (url.includes(key)) return make()
      }
      return new Response('missing', { status: 404 })
    }),
  )
}

describe('IP-block classification', () => {
  it('flags HTTP 429 as rate-limited per host', async () => {
    stubUpstream({
      '/a.m3u8': () => new Response('limit', { status: 429 }),
      '/b.m3u8': () => new Response('limit', { status: 429 }),
      '/ok.m3u8': () =>
        new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\ns.ts', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        }),
    })

    const filtered = await filterPlayableSources(
      [
        { url: 'https://cdn429.example/a.m3u8' },
        { url: 'https://cdn429.example/b.m3u8' },
        { url: 'https://cdnok.example/ok.m3u8' },
      ],
      'http://localhost:3000',
      5000,
      60000,
    )

    expect(filtered.sources.length).toBe(1)
    expect(filtered.removed).toBe(2)
    expect(filtered.blocked).toEqual([
      { host: 'cdn429.example', kind: 'rate-limited', count: 2 },
    ])

    const diags = addBlockedDiagnostic([], filtered.blocked)
    expect(diags.length).toBe(1)
    expect(diags[0].code).toBe('UPSTREAM_IP_BLOCKED')
    expect(diags[0].message).toContain('cdn429.example')
    expect(diags[0].message).toContain('rate-limited')
  })

  it('flags 403 bot challenge but not plain 403 (expired signature)', async () => {
    stubUpstream({
      '/cf.m3u8': () =>
        new Response('<html>Just a moment... cf-challenge</html>', { status: 403 }),
      '/expired.mp4': () => new Response('denied', { status: 403 }),
      '/gone.m3u8': () => new Response('missing', { status: 404 }),
    })

    const filtered = await filterPlayableSources(
      [
        { url: 'https://challenge.example/cf.m3u8' },
        { url: 'https://cdnx.example/expired.mp4' },
        { url: 'https://cdnx.example/gone.m3u8' },
      ],
      'http://localhost:3000',
      5000,
      60000,
    )

    expect(filtered.sources.length).toBe(0)
    expect(filtered.removed).toBe(3)
    expect(filtered.blocked).toEqual([
      { host: 'challenge.example', kind: 'challenge', count: 1 },
    ])
  })

  it('returns no diagnostics when nothing is blocked', () => {
    expect(addBlockedDiagnostic([{ code: 'X' }], [])).toEqual([{ code: 'X' }])
  })
})
