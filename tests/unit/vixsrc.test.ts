import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseProvider } from '@omss/framework'
import type { ProviderMediaObject } from '@omss/framework'
import { createOmssProviders } from '../../plugins/vixsrc-provider/src/index.ts'

const MOVIE: ProviderMediaObject = {
  type: 'movie',
  tmdbId: '27205',
  title: 'Inception',
  releaseYear: '2010',
  imdbId: 'tt1375666',
}

const MANIFEST = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="eng",URI="https://vixsrc.to/playlist/1?type=audio"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English [CC]",LANGUAGE="eng",URI="https://vixsrc.to/playlist/1?type=subtitle"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480
https://vixsrc.to/playlist/1?type=video&rendition=480p
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080
https://vixsrc.to/playlist/1?type=video&rendition=1080p
`

function stubSuccess() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/movie/27205')) {
        return Response.json({ src: '/embed/231752?token=abc' })
      }
      if (url.includes('/embed/231752')) {
        return new Response(
          `{"token":"tok123","expires":"${Math.floor(Date.now() / 1000) + 3600}","url":"https://vixsrc.to/playlist/231752"}`,
          { status: 200 },
        )
      }
      if (url.includes('/playlist/231752')) {
        return new Response(MANIFEST, { status: 200 })
      }
      return new Response('fail', { status: 502 })
    }),
  )
}

describe('VixSrc provider plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('exports createOmssProviders with BaseProvider', () => {
    const [provider] = createOmssProviders({ id: 'vixsrc-test' })
    expect(provider).toBeInstanceOf(BaseProvider)
    expect(provider.id).toBe('vixsrc-test')
  })

  it('maps api → embed → playlist to proxied HLS + subs', async () => {
    BaseProvider.setProxyConfig({ host: 'localhost', port: 3000, protocol: 'http' })
    stubSuccess()

    const [provider] = createOmssProviders({ timeoutMs: 5000 })
    const result = await provider.getMovieSources(MOVIE)

    expect(result.sources.length).toBe(1)
    expect(result.sources[0].type).toBe('hls')
    expect(result.sources[0].quality).toBe('1080p')
    expect(result.sources[0].url).toContain('/v1/proxy?data=')
    expect(result.sources[0].audioTracks[0].label).toBe('English')
    expect(result.subtitles.length).toBe(1)
    expect(result.subtitles[0].label).toBe('English [CC]')
  })

  it('rejects expired tokens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/movie/27205')) {
          return Response.json({ src: '/embed/231752?token=abc' })
        }
        return new Response(`{"token":"old","expires":"1","url":"https://vixsrc.to/playlist/1"}`, {
          status: 200,
        })
      }),
    )

    const [provider] = createOmssProviders({ timeoutMs: 5000 })
    const result = await provider.getMovieSources(MOVIE)
    expect(result.sources.length).toBe(0)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  it('returns empty result when API has no src', async () => {
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
