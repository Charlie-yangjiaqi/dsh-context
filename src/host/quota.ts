import type { Context } from '@deepseek-ai/cordis'
import type { QuotaProvider, QuotaSnapshot, QuotaWindow } from '../shared/types'
import { mountPostRoute, reply } from './postRoute'
import { asRecord } from './record'

export const QUOTA_ROUTE = '/api/dsh-context/quota'

const FETCH_TIMEOUT_MS = 10_000

interface CredentialsHostFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

interface SettingsHostFace {
  describe?(options?: { redactSecrets?: boolean }): unknown
}

interface ProviderIdentity {
  id: string
  label: string
  dashboard: string
}

interface ProviderSpec extends ProviderIdentity {
  fallbackBaseUrl: string
  usagePath: string
  parse(payload: unknown, identity: ProviderIdentity): QuotaProvider | null
}

interface ProviderRoute {
  apiKeyEnv: string
  baseUrl: string
}

type QuotaFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: QuotaFetcher = (url, init) => fetch(url, init)

let fetcher: QuotaFetcher = defaultFetcher

export function setQuotaFetcher(next: QuotaFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

function originOf(baseUrl: string, fallback: string): string {
  if (baseUrl === '') return fallback
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : fallback
  } catch {
    return fallback
  }
}

function routesOf(ctx: Context): Map<string, ProviderRoute> {
  const settings = ctx.get('settings') as SettingsHostFace | undefined
  const routes = new Map<string, ProviderRoute>()
  if (typeof settings?.describe !== 'function') return routes
  let rows: unknown
  try {
    rows = settings.describe({ redactSecrets: true })
  } catch {
    return routes
  }
  if (!Array.isArray(rows)) return routes
  for (const row of rows) {
    const record = asRecord(row)
    const value = record === null ? null : asRecord(record.value)
    const providers = value === null ? null : asRecord(value.providers)
    if (providers === null) continue
    for (const [id, raw] of Object.entries(providers)) {
      if (routes.has(id)) continue
      const entry = asRecord(raw)
      if (entry === null) continue
      const apiKeyEnv = entry.apiKeyEnv
      if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') continue
      const baseURL = entry.baseURL
      routes.set(id, { apiKeyEnv, baseUrl: typeof baseURL === 'string' ? baseURL : '' })
    }
  }
  return routes
}

function percentOf(used: unknown, cap: unknown): number | null {
  if (typeof used !== 'number' || typeof cap !== 'number') return null
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null
  return Math.min(100, Math.max(0, (used / cap) * 100))
}

function isoOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : undefined
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function windowOf(key: string, percent: number | null, resetsAt: string | undefined, exceeded: boolean | undefined): QuotaWindow | null {
  if (percent === null) return null
  return {
    key,
    percent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(exceeded === undefined ? {} : { exceeded }),
  }
}

export function opencodeQuotaOf(payload: unknown, spec: ProviderIdentity): QuotaProvider | null {
  const data = asRecord(payload)
  const usage = data === null ? null : asRecord(data.usage)
  if (usage === null) return null
  const windows: QuotaWindow[] = []
  for (const key of ['rolling', 'weekly', 'monthly']) {
    const window = asRecord(usage[key])
    if (window === null) continue
    const percent = typeof window.percent === 'number' ? window.percent : null
    const entry = windowOf(key, percent, isoOf(window.resetsAt), window.status === 'exceeded' ? true : undefined)
    if (entry !== null) windows.push(entry)
  }
  if (windows.length === 0) return null
  return { id: spec.id, label: spec.label, windows, dashboard: spec.dashboard }
}

export function commandcodeQuotaOf(payload: unknown, spec: ProviderIdentity): QuotaProvider | null {
  const data = asRecord(payload)
  if (data === null) return null
  const windows: QuotaWindow[] = []
  const limits = asRecord(data.windowLimits)
  if (limits !== null) {
    for (const key of ['fiveHour', 'weekly']) {
      const window = asRecord(limits[key])
      if (window === null) continue
      const entry = windowOf(key, percentOf(window.used, window.cap), isoOf(window.resetAt), window.exceeded === true ? true : undefined)
      if (entry !== null) windows.push(entry)
    }
  }
  const credits = asRecord(data.credits)
  const remaining = credits === null ? undefined : credits.monthlyCredits
  const provider: QuotaProvider = {
    id: spec.id,
    label: spec.label,
    windows,
    dashboard: spec.dashboard,
    ...(typeof remaining === 'number' ? { remaining } : {}),
  }
  return windows.length > 0 || provider.remaining !== undefined ? provider : null
}

const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'opencode-go',
    label: 'opencode Go',
    fallbackBaseUrl: 'https://opencode.ai',
    usagePath: '/zen/go/v1/usage',
    dashboard: 'https://opencode.ai',
    parse: opencodeQuotaOf,
  },
  {
    id: 'commandcode',
    label: 'Command Code',
    fallbackBaseUrl: 'https://api.commandcode.ai',
    usagePath: '/alpha/billing/credits',
    dashboard: 'https://commandcode.ai',
    parse: commandcodeQuotaOf,
  },
]

const inFlight = new Map<string, Promise<QuotaProvider | null>>()

export function resetQuota(): void {
  inFlight.clear()
}

async function probe(spec: ProviderSpec, route: ProviderRoute, apiKey: string): Promise<QuotaProvider | null> {
  const url = originOf(route.baseUrl, spec.fallbackBaseUrl) + spec.usagePath
  const key = spec.id + '\u0000' + url + '\u0000' + apiKey
  const pending = inFlight.get(key)
  if (pending !== undefined) return pending
  const promise = (async () => {
    try {
      const response = await fetcher(url, {
        headers: { accept: 'application/json', authorization: 'Bearer ' + apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) return null
      return spec.parse(await response.json(), spec)
    } catch {
      return null
    }
  })()
  inFlight.set(key, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(key)
  }
}

async function readQuota(ctx: Context): Promise<QuotaSnapshot | null> {
  const credentials = ctx.get('credentials') as CredentialsHostFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  const routes = routesOf(ctx)
  const providers: QuotaProvider[] = []
  for (const spec of PROVIDERS) {
    const route = routes.get(spec.id)
    if (route === undefined) continue
    let apiKey = ''
    try {
      const hit = await resolve(route.apiKeyEnv)
      apiKey = typeof hit?.value === 'string' ? hit.value : ''
    } catch {
      apiKey = ''
    }
    if (apiKey === '') continue
    const provider = await probe(spec, route, apiKey)
    if (provider !== null) providers.push(provider)
  }
  return providers.length > 0 ? { providers } : null
}

export function watchQuotaChannel(ctx: Context): void {
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: QUOTA_ROUTE,
    label: 'dsh-context: quota route',
    handler: () => async (): Promise<Response> => reply({ ok: true, value: await readQuota(ctx) }),
  })
}
