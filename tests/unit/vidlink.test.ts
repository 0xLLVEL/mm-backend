import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseProvider } from '@omss/framework'
import type { ProviderMediaObject } from '@omss/framework'
import { createOmssProviders } from '../../plugins/vidlink-provider/src/index.ts'

const MOVIE: ProviderMediaObject = {
  type: 'movie',
  tmdbId: '27205',
  title: 'Inception',
  releaseYear: '2010',
  imdbId: 'tt1375666',
}

function stubVidLinkApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('enc-vidlink?text=27205')) {
        return Response.json({ status: 200, result: 'enc-id-123' })
      }
      if (url.includes('/api/b/movie/enc-id-123')) {
        return Response.json({
          sourceId: 'mwVault',
          stream: {
            qualities: {
              '360': { type: 'mp4', url: 'https://cdn.example/v-360.mp4' },
              '1080': { type: 'mp4', url: 'https://cdn.example/v-1080.mp4' },
            },
            captions: [
              { url: 'https://cdn.example/en.srt', language: 'English', type: 'srt' },
              { url: 'https://cdn.example/ar.srt', language: 'Arabic', type: 'srt' },
            ],
          },
        })
      }
      return new Response('fail', { status: 502 })
    }),
  )
}

describe('VidLink provider plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exports createOmssProviders with BaseProvider', () => {
    const [provider] = createOmssProviders({ id: 'vidlink-test' })
    expect(provider).toBeInstanceOf(BaseProvider)
    expect(provider.id).toBe('vidlink-test')
  })

  it('maps encrypt + api/b qualities to proxied OMSS sources', async () => {
    BaseProvider.setProxyConfig({ host: 'localhost', port: 3000, protocol: 'http' })
    stubVidLinkApi()

    const [provider] = createOmssProviders({ timeoutMs: 5000 })
    const result = await provider.getMovieSources(MOVIE)

    expect(result.sources.length).toBe(2)
    // sorted best quality first
    expect(result.sources[0].quality).toBe('1080p')
    expect(result.sources[0].type).toBe('mp4')
    expect(result.sources[0].url).toContain('/v1/proxy?data=')
    expect(result.sources[0].provider.name).toContain('mwVault')
    expect(result.subtitles.length).toBe(2)
    expect(result.subtitles[0].label).toBe('English')
    expect(result.subtitles[0].format).toBe('srt')
  })

  it('falls back to master playlist when no qualities', async () => {
    BaseProvider.setProxyConfig({ host: 'localhost', port: 3000, protocol: 'http' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('enc-vidlink')) {
          return Response.json({ status: 200, result: 'enc-id-123' })
        }
        return Response.json({
          stream: { playlist: 'https://cdn.example/master.m3u8' },
        })
      }),
    )

    const [provider] = createOmssProviders({ timeoutMs: 5000 })
    const result = await provider.getMovieSources(MOVIE)
    expect(result.sources.length).toBe(1)
    expect(result.sources[0].type).toBe('hls')
    expect(result.sources[0].quality).toBe('Auto')
  })

  it('returns empty result with diagnostics when encrypt fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('fail', { status: 502 })),
    )

    const [provider] = createOmssProviders({ timeoutMs: 1000 })
    const result = await provider.getMovieSources(MOVIE)
    expect(result.sources.length).toBe(0)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })
})
