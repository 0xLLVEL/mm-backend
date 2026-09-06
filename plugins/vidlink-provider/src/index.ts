import { BaseProvider } from '@omss/framework'
import type {
  ProviderCapabilities,
  ProviderMediaObject,
  ProviderResult,
  Source,
  Subtitle,
} from '@omss/framework'

export interface VidLinkPluginConfig {
  id?: string
  name?: string
  apiBaseUrl?: string
  encryptUrl?: string
  timeoutMs?: number
  maxStreams?: number
}

type VidLinkQuality = {
  type?: string
  url?: string
}

type VidLinkCaption = {
  url?: string
  language?: string
  label?: string
  type?: string
}

type VidLinkApiResponse = {
  sourceId?: string
  stream?: {
    playlist?: string
    qualities?: Record<string, VidLinkQuality>
    captions?: VidLinkCaption[]
  }
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

/**
 * OMSS provider for VidLink (`vidlink.pro`):
 * TMDB id → enc-vidlink → `api/b/movie|tv/{enc}` → qualities + captions.
 *
 * @see https://vidlink.pro/ (embed docs)
 */
export class VidLinkProvider extends BaseProvider {
  readonly id: string
  readonly name: string
  readonly enabled = true
  readonly BASE_URL: string
  readonly HEADERS: Record<string, string>
  readonly capabilities: ProviderCapabilities = {
    supportedContentTypes: ['movies', 'tv'],
  }

  private readonly apiBaseUrl: string
  private readonly encryptUrl: string
  private readonly timeoutMs: number
  private readonly maxStreams: number

  constructor(config: VidLinkPluginConfig = {}) {
    super()
    this.id = config.id ?? 'vidlink'
    this.name = config.name ?? 'VidLink'
    this.BASE_URL = 'https://vidlink.pro'
    this.apiBaseUrl = (
      config.apiBaseUrl ??
      process.env.VIDLINK_API_BASE_URL ??
      'https://vidlink.pro/api/b'
    ).replace(/\/$/, '')
    this.encryptUrl = (
      config.encryptUrl ??
      process.env.VIDLINK_ENCRYPT_URL ??
      'https://enc-dec.app/api/enc-vidlink'
    ).replace(/\/$/, '')
    this.timeoutMs =
      config.timeoutMs ?? Number(process.env.VIDLINK_TIMEOUT_MS ?? 18_000)
    // ponytail: default 2 — BunnyCDN per-IP throttles this zone hard;
    // fewer qualities = fewer probe+playback hits per sources call
    this.maxStreams =
      config.maxStreams ?? Number(process.env.VIDLINK_MAX_STREAMS ?? 2)

    this.HEADERS = {
      'User-Agent': DEFAULT_UA,
      Accept: 'application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: this.BASE_URL,
      Referer: `${this.BASE_URL}/`,
    }
  }

  async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
    return this.getSources(media)
  }

  async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
    return this.getSources(media)
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(this.BASE_URL, {
        method: 'HEAD',
        headers: this.HEADERS,
      })
      return response.ok
    } catch {
      return false
    }
  }

  private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
    this.console.log('Fetching VidLink sources', media)

    try {
      // ponytail: api needs only the numeric TMDB id — no TMDB metadata lookup
      const tmdbId = String(media.tmdbId || '').trim()
      if (!/^\d+$/.test(tmdbId)) return this.emptyResult('Invalid TMDB id')

      const encrypted = await this.encryptId(tmdbId)
      if (!encrypted) return this.emptyResult('Failed to encrypt TMDB id')

      const apiUrl =
        media.type === 'tv'
          ? `${this.apiBaseUrl}/tv/${encrypted}/${media.s ?? 1}/${media.e ?? 1}`
          : `${this.apiBaseUrl}/movie/${encrypted}`

      const data = await this.fetchJson<VidLinkApiResponse>(
        apiUrl,
        this.embedHeaders(media),
      )
      if (!data?.stream) return this.emptyResult('No stream in VidLink response')

      const streamHeaders = this.embedHeaders(media)
      const candidates: Array<{ url: string; quality: string; type: 'hls' | 'mp4'; score: number }> = []
      const seen = new Set<string>()

      for (const [key, q] of Object.entries(data.stream.qualities ?? {})) {
        const url = String(q?.url || '').trim()
        if (!url || seen.has(url)) continue
        seen.add(url)
        const quality = /p$/i.test(key) ? key : `${key}p`
        const type = inferSourceType(url, String(q?.type || ''))
        candidates.push({ url, quality, type, score: qualityScore(quality) })
      }

      // ponytail: master playlist fallback when no per-quality urls
      const playlist = String(data.stream.playlist || '').trim()
      if (!candidates.length && playlist && !seen.has(playlist)) {
        candidates.push({ url: playlist, quality: 'Auto', type: 'hls', score: 0 })
      }
      if (!candidates.length) return this.emptyResult('No streams in VidLink response')

      candidates.sort((a, b) => b.score - a.score)
      const sources: Source[] = candidates.slice(0, this.maxStreams).map((row) => ({
        url: this.createProxyUrl(row.url, streamHeaders),
        type: row.type,
        quality: row.quality,
        audioTracks: [{ label: 'Default', language: 'en' }],
        provider: {
          id: this.id,
          name: data.sourceId ? `${this.name}/${data.sourceId}` : this.name,
        },
      }))

      const subtitles: Subtitle[] = []
      const seenSubs = new Set<string>()
      for (const cap of data.stream.captions ?? []) {
        const url = String(cap?.url || '').trim()
        if (!url || seenSubs.has(url)) continue
        seenSubs.add(url)
        const label = String(cap.label || cap.language || 'Subtitle').trim() || 'Subtitle'
        const type = String(cap.type || '').toLowerCase()
        subtitles.push({
          url: this.createProxyUrl(url, streamHeaders),
          label,
          format: type.includes('srt') || url.toLowerCase().includes('.srt') ? 'srt' : 'vtt',
        })
      }
      const preferredSubs = [
        ...subtitles.filter((s) => /eng|english/i.test(s.label)),
        ...subtitles.filter((s) => !/eng|english/i.test(s.label)),
      ].slice(0, 12)

      return { sources, subtitles: preferredSubs, diagnostics: [] }
    } catch (error) {
      return this.emptyResult(
        error instanceof Error ? error.message : 'Unknown provider error',
      )
    }
  }

  private embedHeaders(media: ProviderMediaObject): Record<string, string> {
    const embed =
      media.type === 'tv'
        ? `${this.BASE_URL}/tv/${media.tmdbId}/${media.s ?? 1}/${media.e ?? 1}`
        : `${this.BASE_URL}/movie/${media.tmdbId}`
    return { ...this.HEADERS, Referer: embed }
  }

  private async encryptId(tmdbId: string): Promise<string | null> {
    const json = await this.fetchJson<{ result?: string }>(
      `${this.encryptUrl}?text=${encodeURIComponent(tmdbId)}`,
    )
    const result = String(json?.result || '').trim()
    return result || null
  }

  private async fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(url, {
        headers: headers ?? this.HEADERS,
        signal: controller.signal,
      })
      if (!response.ok) return null
      return (await response.json()) as T
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private emptyResult(message: string): ProviderResult {
    this.console.warn(message)
    return {
      sources: [],
      subtitles: [],
      diagnostics: [
        {
          code: 'PROVIDER_ERROR',
          message: `${this.name}: ${message}`,
          field: '',
          severity: 'error',
        },
      ],
    }
  }
}

function qualityScore(quality: string): number {
  const q = quality.toLowerCase()
  if (/2160|4k|uhd/.test(q)) return 400
  if (/1080|fhd/.test(q)) return 300
  if (/1440|2k/.test(q)) return 250
  if (/720/.test(q)) return 200
  if (/480|360|sd/.test(q)) return 100
  return 150
}

function inferSourceType(url: string, apiType: string): 'hls' | 'mp4' {
  const lower = url.toLowerCase()
  if (lower.includes('.m3u8') || lower.includes('mpegurl')) return 'hls'
  if (lower.includes('.mp4') || apiType.toLowerCase().includes('mp4')) return 'mp4'
  return 'mp4'
}

export function createOmssProviders(
  config: VidLinkPluginConfig = {},
): BaseProvider[] {
  return [new VidLinkProvider(config)]
}
