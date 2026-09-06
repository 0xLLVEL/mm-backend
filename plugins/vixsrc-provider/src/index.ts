import { BaseProvider } from '@omss/framework'
import type {
  AudioTrack,
  ProviderCapabilities,
  ProviderMediaObject,
  ProviderResult,
  Subtitle,
} from '@omss/framework'

export interface VixSrcPluginConfig {
  id?: string
  name?: string
  baseUrl?: string
  timeoutMs?: number
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36'

/**
 * OMSS provider for VixSrc (`vixsrc.to`):
 * `api/movie|tv/{tmdb}` → embed page (token/expires/playlist) →
 * tokenized master m3u8 (variants + audio + subtitles).
 */
export class VixSrcProvider extends BaseProvider {
  readonly id: string
  readonly name: string
  readonly enabled = true
  readonly BASE_URL: string
  readonly HEADERS: Record<string, string>
  readonly capabilities: ProviderCapabilities = {
    supportedContentTypes: ['movies', 'tv'],
  }

  private readonly timeoutMs: number

  constructor(config: VixSrcPluginConfig = {}) {
    super()
    this.id = config.id ?? 'vixsrc'
    this.name = config.name ?? 'VixSrc'
    this.BASE_URL = (
      config.baseUrl ??
      process.env.VIXSRC_BASE_URL ??
      'https://vixsrc.to'
    ).replace(/\/$/, '')
    this.timeoutMs =
      config.timeoutMs ?? Number(process.env.VIXSRC_TIMEOUT_MS ?? 15_000)

    this.HEADERS = {
      'User-Agent': DEFAULT_UA,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: this.BASE_URL,
      Origin: this.BASE_URL,
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
      const json = await this.fetchJson<{ src?: string }>(
        `${this.BASE_URL}/api/movie/27205`,
      )
      return Boolean(json?.src)
    } catch {
      return false
    }
  }

  private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
    this.console.log('Fetching VixSrc sources', media)

    try {
      // ponytail: api needs only the numeric TMDB id — no TMDB metadata lookup
      const tmdbId = String(media.tmdbId || '').trim()
      if (!/^\d+$/.test(tmdbId)) return this.emptyResult('Invalid TMDB id')

      const apiUrl =
        media.type === 'tv'
          ? `${this.BASE_URL}/api/tv/${tmdbId}/${media.s ?? 1}/${media.e ?? 1}`
          : `${this.BASE_URL}/api/movie/${tmdbId}`

      const api = await this.fetchJson<{ src?: string }>(apiUrl)
      if (!api?.src) return this.emptyResult('No embed src in VixSrc API response')

      const html = await this.fetchText(
        new URL(api.src, this.BASE_URL).href,
        { ...this.HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' },
      )
      if (!html) return this.emptyResult('Failed to fetch VixSrc embed page')

      const token = html.match(/["']?token["']?\s*:\s*["']([^"']+)/)?.[1]
      const expires = html.match(/["']?expires["']?\s*:\s*["']([^"']+)/)?.[1]
      const playlist = html.match(/["']?url["']?\s*:\s*["']([^"']+)/)?.[1]
      if (!token || !expires || !playlist) {
        return this.emptyResult('No token/playlist in VixSrc embed page')
      }
      if (Number(expires) * 1000 - 60_000 < Date.now()) {
        return this.emptyResult('VixSrc token expired')
      }

      const sep = playlist.includes('?') ? '&' : '?'
      const masterUrl = `${playlist}${sep}token=${token}&expires=${expires}&h=1`
      const manifest = await this.fetchText(masterUrl, {
        ...this.HEADERS,
        Referer: apiUrl,
      })
      if (!manifest || !manifest.includes('#EXT-X-STREAM-INF')) {
        return this.emptyResult('No HLS variants in VixSrc playlist')
      }

      const streamHeaders = { ...this.HEADERS, Referer: apiUrl }
      const best = bestResolution(manifest)
      const audioTracks = parseAudioTracks(manifest)
      const subtitles = parseSubtitles(manifest, masterUrl, streamHeaders, this)

      return {
        sources: [
          {
            url: this.createProxyUrl(masterUrl, streamHeaders),
            type: 'hls',
            quality: `${best}p`,
            audioTracks,
            provider: { id: this.id, name: this.name },
          },
        ],
        subtitles,
        diagnostics: [],
      }
    } catch (error) {
      return this.emptyResult(
        error instanceof Error ? error.message : 'Unknown provider error',
      )
    }
  }

  /** Exposed for subtitle proxying (createProxyUrl is instance-scoped). */
  proxify(url: string, headers: Record<string, string>): string {
    return this.createProxyUrl(url, headers)
  }

  private async fetchText(url: string, headers?: Record<string, string>): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(url, {
        headers: headers ?? this.HEADERS,
        signal: controller.signal,
      })
      if (!response.ok) return null
      return await response.text()
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const text = await this.fetchText(url)
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
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

function bestResolution(manifest: string): number {
  let best = 0
  const re = /RESOLUTION=\d+x(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(manifest)) !== null) {
    const h = Number(m[1])
    if (Number.isFinite(h) && h > best) best = h
  }
  return best || 1080
}

function parseAudioTracks(manifest: string): AudioTrack[] {
  const tracks: AudioTrack[] = []
  for (const line of manifest.split('\n')) {
    if (!line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) continue
    const language = line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? 'unknown'
    const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Audio'
    tracks.push({ language, label })
  }
  return tracks.length ? tracks : [{ label: 'Default', language: 'en' }]
}

function parseSubtitles(
  manifest: string,
  masterUrl: string,
  headers: Record<string, string>,
  provider: VixSrcProvider,
): Subtitle[] {
  const subs: Subtitle[] = []
  const seen = new Set<string>()
  for (const line of manifest.split('\n')) {
    if (!line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) continue
    const uri = line.match(/URI="([^"]+)"/)?.[1]
    if (!uri || seen.has(uri)) continue
    seen.add(uri)
    const label = line.match(/NAME="([^"]+)"/)?.[1] ?? 'Subtitle'
    const absolute = /^https?:\/\//i.test(uri)
      ? uri
      : new URL(uri, masterUrl).href
    subs.push({ url: provider.proxify(absolute, headers), label, format: 'vtt' })
  }
  return [
    ...subs.filter((s) => /eng|english/i.test(s.label)),
    ...subs.filter((s) => !/eng|english/i.test(s.label)),
  ].slice(0, 12)
}

export function createOmssProviders(
  config: VixSrcPluginConfig = {},
): BaseProvider[] {
  return [new VixSrcProvider(config)]
}
