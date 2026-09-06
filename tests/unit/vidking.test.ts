import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseProvider } from '@omss/framework'
import type { ProviderMediaObject } from '@omss/framework'
import { createOmssProviders } from '../../plugins/vidking-provider/src/index.ts'

describe('VidKing provider plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exports createOmssProviders with BaseProvider', () => {
    const [provider] = createOmssProviders({ id: 'vidking-test' })
    expect(provider).toBeInstanceOf(BaseProvider)
    expect(provider.id).toBe('vidking-test')
  })

  it('maps seed + server + decrypt to proxied OMSS sources', async () => {
    BaseProvider.setProxyConfig({ host: 'localhost', port: 3000, protocol: 'http' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/seed?mediaId=27205')) {
          return Response.json({ seed: 'testseed', ttlMs: 30000 })
        }
        if (url.includes('/cdn/sources-with-title')) {
          return new Response('encrypted-blob-payload-padding-1234567890', { status: 200 })
        }
        if (url.includes('enc-dec.app')) {
          return Response.json({
            status: 200,
            result: {
              sources: [{ url: 'https://cdn.example/inception.m3u8', quality: '1080p' }],
              subtitles: [{ url: 'https://cdn.example/en.vtt', label: 'English' }],
            },
          })
        }
        return new Response('fail', { status: 502 })
      }),
    )

    const [provider] = createOmssProviders({
      servers: ['yoru'],
      timeoutMs: 5000,
    })

    const media: ProviderMediaObject = {
      type: 'movie',
      tmdbId: '27205',
      title: 'Inception',
      releaseYear: '2010',
      imdbId: 'tt1375666',
    }

    const result = await provider.getMovieSources(media)
    expect(result.sources.length).toBe(1)
    expect(result.sources[0].url).toContain('/v1/proxy?data=')
    expect(result.sources[0].type).toBe('hls')
    expect(result.sources[0].quality).toBe('1080p')
    expect(result.subtitles.length).toBe(1)
  })

  it('returns empty result with diagnostics when seed fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('fail', { status: 502 })),
    )

    const [provider] = createOmssProviders({ servers: ['yoru'], timeoutMs: 1000 })
    const media: ProviderMediaObject = {
      type: 'movie',
      tmdbId: '27205',
      title: 'Inception',
      releaseYear: '2010',
      imdbId: 'tt1375666',
    }

    const result = await provider.getMovieSources(media)
    expect(result.sources.length).toBe(0)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })
})
