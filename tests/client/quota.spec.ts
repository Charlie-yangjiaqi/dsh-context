// @vitest-environment node

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { QUOTA_STORAGE_KEY, QUOTA_STORAGE_TTL_MS, quotaOf, readProviderQuota, resetProviderQuota, setQuotaStorage, type QuotaStorageFace } from '../../src/client/quota'
import type { QuotaSnapshot } from '../../src/shared/types'

describe('quota', () => {

const WIRE = {
  providers: [
    {
      id: 'opencode-go',
      label: 'opencode Go',
      dashboard: 'https://opencode.ai',
      windows: [
        { key: 'rolling', percent: 42, resetsAt: '2026-11-20T10:00:00.000Z' },
        { key: 'weekly', percent: 12, exceeded: true },
      ],
    },
    { id: 'commandcode', label: 'Command Code', dashboard: '', windows: [], remaining: 61.5 },
  ],
}

class FakeStorage implements QuotaStorageFace {
  store = new Map<string, string>()
  failGet = false
  failSet = false
  constructor(seed?: Record<string, string>) {
    for (const [key, value] of Object.entries(seed ?? {})) this.store.set(key, value)
  }
  getItem(key: string): string | null {
    if (this.failGet) throw new Error('denied')
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('denied')
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
}

function stubRoute(body: unknown, mode: 'ok' | 'reject' | 'status' = 'ok'): { calls: () => number } {
  let n = 0
  vi.stubGlobal('fetch', async () => {
    n++
    if (mode === 'reject') throw new Error('down')
    if (mode === 'status') return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: body }) }
  })
  return { calls: () => n }
}

function seeded(snapshot: unknown, at = Date.now()): FakeStorage {
  const fake = new FakeStorage({ [QUOTA_STORAGE_KEY]: JSON.stringify({ at, quota: snapshot }) })
  setQuotaStorage(fake)
  return fake
}

function collector(): { seen: QuotaSnapshot[]; onRefresh: (value: QuotaSnapshot) => void } {
  const seen: QuotaSnapshot[] = []
  return { seen, onRefresh: (value) => seen.push(value) }
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  resetProviderQuota()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  resetProviderQuota()
  setQuotaStorage(undefined)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('decode', () => {
  test('keeps every field the host sends and drops the provider and window shapes it does not understand', () => {
    const snapshot = quotaOf(WIRE)
    assert.deepEqual(snapshot?.providers.map(provider => provider.id), ['opencode-go', 'commandcode'])
    assert.deepEqual(snapshot?.providers[0]?.windows, [
      { key: 'rolling', percent: 42, resetsAt: '2026-11-20T10:00:00.000Z' },
      { key: 'weekly', percent: 12, exceeded: true },
    ])
    assert.equal(snapshot?.providers[1]?.remaining, 61.5)
    assert.equal(snapshot?.providers[1]?.windows.length, 0)
  })

  test('rejects the payloads that carry no usable provider', () => {
    assert.equal(quotaOf(null), null)
    assert.equal(quotaOf('nope'), null)
    assert.equal(quotaOf({}), null)
    assert.equal(quotaOf({ providers: 'nope' }), null)
    assert.equal(quotaOf({ providers: [null, 'nope', { id: '', label: 'x' }, { id: 'x', label: '' }] }), null)
  })

  test('skips malformed windows and falls back for the optional fields', () => {
    const snapshot = quotaOf({
      providers: [{
        id: 'commandcode',
        label: 'Command Code',
        windows: [null, { key: '', percent: 1 }, { key: 'weekly', percent: 'x' }, { key: 'monthly', percent: Number.NaN }, { key: 'fiveHour', percent: 30, resetsAt: '', exceeded: false }],
        remaining: Number.NaN,
      }],
    })
    assert.deepEqual(snapshot?.providers[0]?.windows, [{ key: 'fiveHour', percent: 30 }])
    assert.equal(snapshot?.providers[0]?.remaining, undefined)
    assert.equal(snapshot?.providers[0]?.dashboard, '')
    const bare = quotaOf({ providers: [{ id: 'bare', label: 'Bare' }] })
    assert.deepEqual(bare?.providers[0]?.windows, [])
  })
})

describe('storage', () => {
  test('a fresh cached snapshot lands before the route answers and survives a broken route', async () => {
    seeded(WIRE)
    stubRoute(WIRE, 'reject')
    const collected = collector()
    const value = readProviderQuota(collected.onRefresh)
    assert.equal(value?.providers.length, 2)
    await drain()
    assert.equal(collected.seen.length, 0)
  })

  test('an expired cache is dropped, unreadable storage and unwritable storage are tolerated', async () => {
    const stale = seeded(WIRE, Date.now() - QUOTA_STORAGE_TTL_MS - 1)
    stubRoute(WIRE, 'reject')
    assert.equal(readProviderQuota(() => {}), null)
    assert.equal(stale.store.has(QUOTA_STORAGE_KEY), false)
    await drain()

    const broken = new FakeStorage({ [QUOTA_STORAGE_KEY]: JSON.stringify(WIRE) })
    broken.failGet = true
    setQuotaStorage(broken)
    assert.equal(readProviderQuota(() => {}), null)

    const refusing = new FakeStorage()
    refusing.failSet = true
    setQuotaStorage(refusing)
    readProviderQuota(() => {})
    await drain()
  })

  test('plain snapshots without the cache envelope and non-object caches decode through the payload reader', () => {
    setQuotaStorage(new FakeStorage({ [QUOTA_STORAGE_KEY]: JSON.stringify(WIRE) }))
    stubRoute(WIRE, 'reject')
    assert.equal(readProviderQuota(() => {})?.providers.length, 2)

    resetProviderQuota()
    setQuotaStorage(new FakeStorage({ [QUOTA_STORAGE_KEY]: JSON.stringify('nope') }))
    assert.equal(readProviderQuota(() => {}), null)

    resetProviderQuota()
    setQuotaStorage(new FakeStorage({ [QUOTA_STORAGE_KEY]: 'not json' }))
    assert.equal(readProviderQuota(() => {}), null)

    resetProviderQuota()
    setQuotaStorage(new FakeStorage({ [QUOTA_STORAGE_KEY]: JSON.stringify({ at: 'nope', quota: WIRE }) }))
    assert.equal(readProviderQuota(() => {}), null)
  })
})

describe('route reads', () => {
  test('a successful read caches the snapshot and notifies every caller', async () => {
    const fake = new FakeStorage()
    setQuotaStorage(fake)
    stubRoute(WIRE)
    const first = collector()
    readProviderQuota(first.onRefresh)
    await drain()
    assert.equal(first.seen.length, 1)
    assert.equal(JSON.parse(fake.store.get(QUOTA_STORAGE_KEY) ?? '{}').quota.providers.length, 2)

    const second = collector()
    assert.equal(readProviderQuota(second.onRefresh)?.providers.length, 2)
    await drain()
    assert.equal(second.seen.length, 1)
  })

  test('concurrent readers share one in-flight request', async () => {
    const fake = new FakeStorage()
    setQuotaStorage(fake)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      await gate
      return { ok: true, status: 200, json: async () => ({ ok: true, value: WIRE }) }
    })
    const first = collector()
    const second = collector()
    readProviderQuota(first.onRefresh)
    readProviderQuota(second.onRefresh)
    release()
    await drain()
    assert.equal(calls, 1)
    assert.equal(first.seen.length, 1)
    assert.equal(second.seen.length, 1)
  })

  test('a failed or malformed route leaves the cache untouched', async () => {
    stubRoute(WIRE, 'status')
    assert.equal(readProviderQuota(() => {}), null)
    await drain()
    resetProviderQuota()
    stubRoute({ providers: [] })
    assert.equal(readProviderQuota(() => {}), null)
    await drain()
  })
})
})
