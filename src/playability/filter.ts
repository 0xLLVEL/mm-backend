export type OmssSource = {
  url?: string
  provider?: { id?: string; name?: string }
  type?: string
}

export type OmssDiagnostic = {
  code?: string
  message?: string
  field?: string
  severity?: string
}

export type ProbeResult = {
  ok: boolean
  reason: string
  /** Set when the failure looks like server-IP blocking rather than a dead link */
  blocked?: 'rate-limited' | 'challenge' | null
}

export type BlockedHost = {
  host: string
  kind: 'rate-limited' | 'challenge'
  count: number
}

const DEFAULT_PROBE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const playabilityCache = new Map<string, { expiresAt: number; result: ProbeResult }>()

function probesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test') return true
  const flag = (env.INTERNAL_DEBUG || '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

/** Reach this process directly when PUBLIC_URL is a public hostname that may not hairpin. */
function localLoopbackOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const port = Number(env.PORT ?? 3000)
  return `http://127.0.0.1:${port}`
}

function probeFetchUrl(fullUrl: string, fallbackOrigin: string): string {
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '')
  if (publicUrl && fullUrl.startsWith(publicUrl)) {
    return `${localLoopbackOrigin()}${fullUrl.slice(publicUrl.length)}`
  }
  if (fullUrl.startsWith('/')) {
    return new URL(fullUrl, fallbackOrigin.startsWith('http') ? fallbackOrigin : localLoopbackOrigin()).toString()
  }
  return fullUrl
}

export async function filterPlayableSources(
  sources: OmssSource[],
  origin: string,
  timeoutMs: number,
  cacheTtlMs: number,
): Promise<{ sources: OmssSource[]; removed: number; blocked: BlockedHost[] }> {
  if (probesDisabled()) {
    return { sources, removed: 0, blocked: [] }
  }

  const checks = await Promise.all(
    sources.map(async (source) => ({
      source,
      probe: await probePlayableSource(source, origin, timeoutMs, cacheTtlMs),
    })),
  )

  const kept = checks.filter((row) => row.probe.ok).map((row) => row.source)
  return { sources: kept, removed: sources.length - kept.length, blocked: collectBlocked(checks) }
}

/** Aggregate blocked probes per upstream host so callers emit one diagnostic each. */
function collectBlocked(
  checks: Array<{ source: OmssSource; probe: ProbeResult }>,
): BlockedHost[] {
  const byHost = new Map<string, { kind: 'rate-limited' | 'challenge'; count: number }>()
  for (const { source, probe } of checks) {
    if (probe.ok || !probe.blocked) continue
    const host = hostOf(String(source.url || ''))
    if (!host) continue
    const row = byHost.get(host)
    if (row) {
      row.count += 1
      // ponytail: rate-limited wins ties — it's the actionable signal
      if (probe.blocked === 'rate-limited') row.kind = 'rate-limited'
    } else {
      byHost.set(host, { kind: probe.blocked, count: 1 })
    }
  }
  return [...byHost.entries()].map(([host, row]) => ({ host, ...row }))
}

/** One warning diagnostic per blocked host (empty when nothing blocked). */
export function addBlockedDiagnostic(
  diagnostics: OmssDiagnostic[],
  blocked: BlockedHost[],
): OmssDiagnostic[] {
  if (!blocked.length) return diagnostics
  return [
    ...diagnostics,
    ...blocked.map((b) => ({
      code: 'UPSTREAM_IP_BLOCKED',
      severity: 'warning',
      field: '',
      message:
        b.kind === 'rate-limited'
          ? `${b.host} rate-limited this server IP (HTTP 429 on ${b.count} source(s)) — possible IP block`
          : `${b.host} served a bot challenge (HTTP 403 on ${b.count} source(s)) — possible IP block`,
    })),
  ]
}

export function addPlayableFilterDiagnostic(
  diagnostics: OmssDiagnostic[],
  removed: number,
  code = 'UNPLAYABLE_SOURCE_FILTERED',
  messagePrefix = 'Filtered',
): OmssDiagnostic[] {
  if (removed <= 0) return diagnostics
  return [
    ...diagnostics,
    {
      code,
      severity: 'info',
      field: '',
      message:
        removed === 1
          ? `${messagePrefix} 1 unplayable source after probe`
          : `${messagePrefix} ${removed} unplayable sources after probe`,
    },
  ]
}

export function defaultProbeOrigin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, '')
  const host = env.HOST && env.HOST !== '0.0.0.0' ? env.HOST : 'localhost'
  const port = Number(env.PORT ?? 3000)
  return `http://${host}:${port}`
}

/**
 * 429 = rate-limited, full stop. 403 is usually an expired signature —
 * only call it a block when bot-challenge markers are present.
 */
function classifyBlocked(
  status: number,
  contentType: string,
  head: string,
  cfMitigated: string | null,
): 'rate-limited' | 'challenge' | null {
  if (status === 429) return 'rate-limited'
  if (status !== 403) return null
  if (cfMitigated?.toLowerCase().includes('challenge')) return 'challenge'
  const text = `${contentType} ${head}`.toLowerCase()
  if (
    text.includes('cf-challenge') ||
    text.includes('just a moment') ||
    text.includes('attention required') ||
    text.includes('cf-turnstile') ||
    text.includes('rcp_verify')
  ) {
    return 'challenge'
  }
  return null
}

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname || null
  } catch {
    return null
  }
}

async function probePlayableSource(
  source: OmssSource,
  origin: string,
  timeoutMs: number,
  cacheTtlMs: number,
): Promise<ProbeResult> {
  const rawUrl = String(source.url || '').trim()
  if (!rawUrl) return { ok: false, reason: 'no-url' }

  const cacheKey = rawUrl
  const now = Date.now()
  const cached = playabilityCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.result

  const full = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, origin).toString()
  const fetchUrl = probeFetchUrl(full, origin)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(fetchUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: '*/*',
        'User-Agent': DEFAULT_PROBE_UA,
      },
    })

    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    const reader = response.body?.getReader()
    let prefix = Buffer.alloc(0)
    if (reader) {
      const { value } = await reader.read()
      if (value) prefix = Buffer.from(value)
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }

    const head = prefix.toString('utf8', 0, Math.min(prefix.length, 160))
    const blocked = classifyBlocked(response.status, contentType, head, response.headers.get('cf-mitigated'))
    const isM3u8 =
      contentType.includes('mpegurl') ||
      contentType.includes('apple') ||
      head.includes('#EXTM3U')
    const isDash = contentType.includes('mpd') || head.includes('<MPD')
    const isVideo =
      contentType.includes('video/') ||
      contentType.includes('octet-stream') ||
      contentType.includes('mp2t')
    const ok =
      response.status >= 200 &&
      response.status < 400 &&
      (isM3u8 || isDash || isVideo || prefix.length > 32)

    const result = {
      ok,
      blocked: ok ? null : blocked,
      reason: ok
        ? isM3u8
          ? 'hls'
          : isDash
            ? 'dash'
            : isVideo
              ? 'video'
              : 'bytes'
        : blocked === 'rate-limited'
          ? `status=429 (rate-limited)`
          : blocked === 'challenge'
            ? `status=${response.status} (bot challenge)`
            : `status=${response.status} ct=${contentType}`,
    }
    playabilityCache.set(cacheKey, { result, expiresAt: now + cacheTtlMs })
    return result
  } catch (error) {
    const result = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
    playabilityCache.set(cacheKey, { result, expiresAt: now + Math.min(cacheTtlMs, 30_000) })
    return result
  } finally {
    clearTimeout(timer)
  }
}
