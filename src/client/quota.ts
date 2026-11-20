import type { QuotaProvider, QuotaSnapshot, QuotaWindow } from '../shared/types'
import { QUOTA_ROUTE } from './apiRoutes'
import { postRouteQuietly } from './route'
import { asRecord } from './services'

const STORAGE_KEY = 'dsh-context:provider-quota'

export const QUOTA_STORAGE_KEY = STORAGE_KEY

export const QUOTA_STORAGE_TTL_MS = 10 * 60 * 1000

export interface QuotaStorageFace {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

let storage: QuotaStorageFace | null | undefined

export function setQuotaStorage(next: QuotaStorageFace | null | undefined): void {
  storage = next
}

function storageFn(): QuotaStorageFace | null {
  if (storage !== undefined) return storage
  try {
    const found: unknown = globalThis.localStorage
    storage = found === null || found === undefined ? null : found as QuotaStorageFace
  } catch {
    storage = null
  }
  return storage
}

function windowOf(value: unknown): QuotaWindow | null {
  const entry = asRecord(value)
  if (entry === null) return null
  const key = entry.key
  const percent = entry.percent
  if (typeof key !== 'string' || key === '' || typeof percent !== 'number' || !Number.isFinite(percent)) return null
  const resetsAt = typeof entry.resetsAt === 'string' && entry.resetsAt !== '' ? entry.resetsAt : undefined
  const exceeded = entry.exceeded === true ? true : undefined
  return {
    key,
    percent,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(exceeded === undefined ? {} : { exceeded }),
  }
}

function providerOf(value: unknown): QuotaProvider | null {
  const entry = asRecord(value)
  if (entry === null) return null
  const id = entry.id
  const label = entry.label
  const dashboard = entry.dashboard
  if (typeof id !== 'string' || id === '' || typeof label !== 'string' || label === '') return null
  const windows: QuotaWindow[] = []
  if (Array.isArray(entry.windows)) {
    for (const raw of entry.windows) {
      const window = windowOf(raw)
      if (window !== null) windows.push(window)
    }
  }
  const remaining = typeof entry.remaining === 'number' && Number.isFinite(entry.remaining) ? entry.remaining : undefined
  return {
    id,
    label,
    windows,
    dashboard: typeof dashboard === 'string' ? dashboard : '',
    ...(remaining === undefined ? {} : { remaining }),
  }
}

export function quotaOf(value: unknown): QuotaSnapshot | null {
  const data = asRecord(value)
  if (data === null || !Array.isArray(data.providers)) return null
  const providers: QuotaProvider[] = []
  for (const raw of data.providers) {
    const provider = providerOf(raw)
    if (provider !== null) providers.push(provider)
  }
  return providers.length > 0 ? { providers } : null
}

function storedQuota(): QuotaSnapshot | null {
  try {
    const raw = storageFn()?.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined) return null
    const parsed: unknown = JSON.parse(raw)
    const envelope = asRecord(parsed)
    if (envelope === null) return quotaOf(parsed)
    if (typeof envelope.at !== 'number' || !Number.isFinite(envelope.at)) return quotaOf(parsed)
    if (Date.now() - envelope.at > QUOTA_STORAGE_TTL_MS) {
      storageFn()?.removeItem(STORAGE_KEY)
      return null
    }
    return quotaOf(envelope.quota)
  } catch {
    return null
  }
}

function rememberQuota(value: QuotaSnapshot): void {
  try {
    storageFn()?.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), quota: value }))
  } catch {
  }
}

let cached: QuotaSnapshot | null = null
let refreshing: Promise<void> | null = null
const landingCallbacks = new Set<(value: QuotaSnapshot) => void>()

export function readProviderQuota(onRefresh: (value: QuotaSnapshot) => void): QuotaSnapshot | null {
  landingCallbacks.add(onRefresh)
  if (refreshing === null) {
    refreshing = (async () => {
      const value = await postRouteQuietly(QUOTA_ROUTE, {}, quotaOf)
      if (value === null) return
      cached = value
      rememberQuota(value)
      for (const waiter of landingCallbacks) waiter(value)
    })().finally(() => {
      refreshing = null
      landingCallbacks.clear()
    })
  }
  return cached ?? storedQuota()
}

export function resetProviderQuota(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
  try {
    storageFn()?.removeItem(STORAGE_KEY)
  } catch {
  }
  storage = undefined
}
