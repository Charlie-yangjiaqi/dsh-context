import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeQuotaCapsule } from '../../../src/client/components/quotaCapsule'
import { QUOTA_STORAGE_KEY, resetProviderQuota, setQuotaStorage, type QuotaStorageFace } from '../../../src/client/quota'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

describe('quotaCapsule', () => {

const kit = makeKit()

const ctx = asClientCtx(new TestClientCtx())

const REFRESH_MS = 5 * 60 * 1000

const WIRE = {
  providers: [
    {
      id: 'opencode-go',
      label: 'opencode Go',
      dashboard: 'https://opencode.ai',
      windows: [
        { key: 'rolling', percent: 42, resetsAt: '2026-11-20T10:00:00.000Z' },
        { key: 'weekly', percent: 12 },
      ],
    },
    { id: 'commandcode', label: 'Command Code', dashboard: '', windows: [], remaining: 61.5 },
  ],
}

class FakeStorage implements QuotaStorageFace {
  store = new Map<string, string>()
  constructor(seed: Record<string, string>) {
    for (const [key, value] of Object.entries(seed)) this.store.set(key, value)
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
}

function seed(snapshot: unknown): void {
  setQuotaStorage(new FakeStorage({ [QUOTA_STORAGE_KEY]: JSON.stringify({ at: Date.now(), quota: snapshot }) }))
}

function stubRoute(calls: { n: number }): void {
  vi.stubGlobal('fetch', () => {
    calls.n++
    return new Promise(() => {})
  })
}

beforeEach(() => {
  resetProviderQuota()
})

afterEach(() => {
  resetProviderQuota()
  setQuotaStorage(undefined)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('render', () => {
  test('renders nothing until a snapshot with providers lands', async () => {
    const calls = { n: 0 }
    stubRoute(calls)
    setQuotaStorage(new FakeStorage({}))
    const QuotaCapsule = makeQuotaCapsule(ctx, kit)
    const m = await mount(h(QuotaCapsule))
    assert.equal(text(m.container), '')
    await m.unmount()
  })

  test('renders one chip per provider with the tightest remaining share and a per-window tip', async () => {
    const calls = { n: 0 }
    stubRoute(calls)
    seed(WIRE)
    const QuotaCapsule = makeQuotaCapsule(ctx, kit)
    const m = await mount(h(QuotaCapsule))
    const chips = queryAll(m.container, '.lc-ov-quota')
    assert.equal(chips.length, 2)
    assert.equal(text(chips[0]), 'opencode Go58%')
    assert.equal(chips[0].getAttribute('href'), 'https://opencode.ai')
    assert.equal(chips[0].getAttribute('data-lc-tip'), '5-hour 42% used\nWeekly 12% used')
    assert.equal(text(chips[1]), 'Command Code100%')
    assert.equal(chips[1].getAttribute('href'), null)
    assert.equal(chips[1].getAttribute('data-lc-tip'), '62 credits left')
    await m.unmount()
  })

  test('an unknown window key falls back to the 5-hour label and a bare provider keeps its label only', async () => {
    const calls = { n: 0 }
    stubRoute(calls)
    seed({
      providers: [
        { id: 'first', label: 'First', dashboard: '', windows: [{ key: 'custom', percent: 5 }] },
        { id: 'second', label: 'Second', dashboard: '', windows: [] },
      ],
    })
    const QuotaCapsule = makeQuotaCapsule(ctx, kit)
    const m = await mount(h(QuotaCapsule))
    const chips = queryAll(m.container, '.lc-ov-quota')
    assert.equal(chips[0].getAttribute('data-lc-tip'), '5-hour 5% used')
    assert.equal(chips[1].getAttribute('data-lc-tip'), null)
    assert.equal(chips[1].getAttribute('aria-label'), 'Second')
    assert.ok(query(m.container, '.lc-ov-quota-value') !== null)
    await m.unmount()
  })
})

describe('refresh', () => {
  test('re-reads the route every five minutes and stops on unmount', async () => {
    vi.useFakeTimers()
    const calls = { n: 0 }
    vi.stubGlobal('fetch', async () => {
      calls.n++
      return { ok: true, status: 200, json: async () => ({ ok: true, value: WIRE }) }
    })
    seed(WIRE)
    const QuotaCapsule = makeQuotaCapsule(ctx, kit)
    const m = await mount(h(QuotaCapsule))
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    assert.equal(calls.n, 1)
    await act(async () => { vi.advanceTimersByTime(REFRESH_MS) })
    assert.equal(calls.n, 2)
    await m.unmount()
    await act(async () => { vi.advanceTimersByTime(REFRESH_MS) })
    assert.equal(calls.n, 2)
  })
})
})
