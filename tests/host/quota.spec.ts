import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'vitest'
import { QUOTA_ROUTE, commandcodeQuotaOf, opencodeQuotaOf, resetQuota, setQuotaFetcher, watchQuotaChannel } from '../../src/host/quota'
import { fakeCtx, type FakeRoute } from './helpers/ctx'

const OPENCODE_SPEC = { id: 'opencode-go', label: 'opencode Go', fallbackBaseUrl: 'https://opencode.ai', dashboard: 'https://opencode.ai' }

const CC_SPEC = { id: 'commandcode', label: 'Command Code', fallbackBaseUrl: 'https://api.commandcode.ai', dashboard: 'https://commandcode.ai' }

interface FetchLog { url: string; auth?: string }

function settingsOf(providers: unknown, mode: 'ok' | 'throws' | 'not-array' = 'ok'): { describe(): unknown } {
  return {
    describe() {
      if (mode === 'throws') throw new Error('hostile describe')
      if (mode === 'not-array') return 'nope'
      return [{ ns: 'llm-pi-ai', value: { providers } }]
    },
  }
}

function rowsOf(rows: unknown[]): { describe(): unknown } {
  return { describe: () => rows }
}

function credentialsOf(values: Record<string, unknown>, mode: 'ok' | 'throws' = 'ok'): { resolve(ref: string): Promise<unknown> } {
  return {
    resolve(ref: string) {
      if (mode === 'throws') return Promise.reject(new Error('hostile resolver'))
      const value = values[ref]
      return Promise.resolve(value === undefined ? undefined : { value })
    },
  }
}

function stubFetcher(bodies: Record<string, unknown>, log: FetchLog[], status = 200): void {
  setQuotaFetcher(async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    log.push({ url, auth: headers.authorization })
    const body = url.includes('/zen/go/v1/usage') ? bodies.opencode : bodies.commandcode
    return { ok: status === 200, status, json: async () => body } as unknown as Response
  })
}

async function serve(captured: FakeRoute): Promise<Record<string, unknown>> {
  assert.notEqual(captured.fetch, undefined)
  const response = await captured.fetch?.(new Request('http://localhost' + QUOTA_ROUTE, { method: 'POST' }))
  return await response?.json() as Record<string, unknown>
}

function mounted(services: Record<string, unknown>): { ctx: Parameters<typeof watchQuotaChannel>[0]; captured: FakeRoute } {
  const fake = fakeCtx({ connection: { fetch: { register: () => () => {} } }, ...services })
  watchQuotaChannel(fake.ctx)
  return { ctx: fake.ctx, captured: fake.captured }
}

const OPENCODE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 42, resetsAt: '2026-11-20T10:00:00.000Z' },
    weekly: { status: 'exceeded', percent: 12 },
    monthly: { percent: 'nope' },
  },
}

const COMMANDCODE_BODY = {
  credits: { monthlyCredits: 61.5 },
  windowLimits: {
    fiveHour: { used: 30, cap: 60, resetAt: 1_763_700_000_000, exceeded: false },
    weekly: { used: 240, cap: 200, resetAt: 1_763_800_000_000, exceeded: true },
  },
}

const TWO_PROVIDERS = {
  'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY' },
  commandcode: { apiKeyEnv: 'COMMANDCODE_API_KEY', baseURL: 'https://api.commandcode.ai/provider/v1' },
}

const TWO_KEYS = { OPENCODE_API_KEY: 'key-opencode', COMMANDCODE_API_KEY: 'key-commandcode' }

beforeEach(() => {
  resetQuota()
})

afterEach(() => {
  resetQuota()
  setQuotaFetcher(null)
})

describe('opencode payload', () => {
  test('keeps usable windows, marks the exceeded one, and drops the rest', () => {
    const provider = opencodeQuotaOf(OPENCODE_BODY, OPENCODE_SPEC)
    assert.deepEqual(provider?.windows, [
      { key: 'rolling', percent: 42, resetsAt: '2026-11-20T10:00:00.000Z' },
      { key: 'weekly', percent: 12, exceeded: true },
    ])
    assert.equal(opencodeQuotaOf(null, OPENCODE_SPEC), null)
    assert.equal(opencodeQuotaOf({}, OPENCODE_SPEC), null)
    assert.equal(opencodeQuotaOf({ usage: { rolling: {}, weekly: {}, monthly: {} } }, OPENCODE_SPEC), null)
    const invalidReset = opencodeQuotaOf({ usage: { rolling: { percent: 5, resetsAt: 'not a date' } } }, OPENCODE_SPEC)
    assert.deepEqual(invalidReset?.windows, [{ key: 'rolling', percent: 5 }])
  })
})

describe('command code payload', () => {
  test('turns used and cap into a clamped percent, carries the credit balance, and tolerates missing sections', () => {
    const provider = commandcodeQuotaOf(COMMANDCODE_BODY, CC_SPEC)
    assert.deepEqual(provider?.windows, [
      { key: 'fiveHour', percent: 50, resetsAt: new Date(1_763_700_000_000).toISOString() },
      { key: 'weekly', percent: 100, resetsAt: new Date(1_763_800_000_000).toISOString(), exceeded: true },
    ])
    assert.equal(provider?.remaining, 61.5)

    const clamped = commandcodeQuotaOf({ windowLimits: { fiveHour: { used: -10, cap: 100 }, weekly: { used: 10, cap: 0 } } }, CC_SPEC)
    assert.deepEqual(clamped?.windows, [{ key: 'fiveHour', percent: 0 }])

    assert.equal(commandcodeQuotaOf(null, CC_SPEC), null)
    assert.equal(commandcodeQuotaOf({}, CC_SPEC), null)
    assert.equal(commandcodeQuotaOf({ windowLimits: 'nope', credits: 'nope' }, CC_SPEC), null)
    assert.equal(commandcodeQuotaOf({ credits: { monthlyCredits: 4 } }, CC_SPEC)?.remaining, 4)
    assert.equal(commandcodeQuotaOf({ credits: { monthlyCredits: 'nope' } }, CC_SPEC), null)
    assert.deepEqual(commandcodeQuotaOf({ windowLimits: { fiveHour: null, weekly: {} } }, CC_SPEC), null)
    assert.deepEqual(commandcodeQuotaOf({ windowLimits: { fiveHour: { used: 'x', cap: 10 } } }, CC_SPEC), null)
    assert.deepEqual(commandcodeQuotaOf({ windowLimits: { fiveHour: { used: 1, cap: 'x' } } }, CC_SPEC), null)
    assert.deepEqual(commandcodeQuotaOf({ windowLimits: { fiveHour: { used: Number.NaN, cap: 10 } } }, CC_SPEC), null)
    assert.deepEqual(commandcodeQuotaOf({ windowLimits: { fiveHour: { used: 1, cap: Number.NaN } } }, CC_SPEC), null)
    assert.deepEqual(commandcodeQuotaOf({ windowLimits: { fiveHour: { used: 1, cap: 2, resetAt: Number.NaN } } }, CC_SPEC)?.windows, [
      { key: 'fiveHour', percent: 50 },
    ])
  })
})

describe('quota route', () => {
  test('probes every configured provider with its own key and normalizes both payloads', async () => {
    const log: FetchLog[] = []
    stubFetcher({ opencode: OPENCODE_BODY, commandcode: COMMANDCODE_BODY }, log)
    const { captured } = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: credentialsOf(TWO_KEYS) })
    assert.equal(captured.path, QUOTA_ROUTE)
    const payload = await serve(captured)
    assert.equal(payload.ok, true)
    const value = payload.value as { providers: { id: string; windows: unknown[] }[] }
    assert.deepEqual(value.providers.map(provider => provider.id), ['opencode-go', 'commandcode'])
    assert.deepEqual(log.map(entry => entry.url), [
      'https://opencode.ai/zen/go/v1/usage',
      'https://api.commandcode.ai/alpha/billing/credits',
    ])
    assert.deepEqual(log.map(entry => entry.auth), ['Bearer key-opencode', 'Bearer key-commandcode'])
  })

  test('a provider route with an unusable base URL and an unusable protocol falls back to the public host', async () => {
    const log: FetchLog[] = []
    stubFetcher({ opencode: OPENCODE_BODY, commandcode: COMMANDCODE_BODY }, log)
    const { captured } = mounted({
      settings: settingsOf({
        'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY', baseURL: 'not a url' },
        commandcode: { apiKeyEnv: 'COMMANDCODE_API_KEY', baseURL: 'ftp://example.test' },
      }),
      credentials: credentialsOf(TWO_KEYS),
    })
    await serve(captured)
    assert.deepEqual(log.map(entry => entry.url), [
      'https://opencode.ai/zen/go/v1/usage',
      'https://api.commandcode.ai/alpha/billing/credits',
    ])
  })

  test('absent settings, a throwing describe, and non-array rows leave the snapshot empty', async () => {
    const log: FetchLog[] = []
    stubFetcher({}, log)
    for (const settings of [undefined, settingsOf({}, 'throws'), settingsOf({}, 'not-array')]) {
      const { captured } = mounted({ settings, credentials: credentialsOf(TWO_KEYS) })
      assert.equal((await serve(captured)).value, null)
    }
    assert.equal(log.length, 0)
  })

  test('provider rows with missing, empty, or duplicated entries resolve to the usable ones only', async () => {
    const log: FetchLog[] = []
    stubFetcher({ opencode: OPENCODE_BODY, commandcode: COMMANDCODE_BODY }, log)
    const { captured } = mounted({
      settings: rowsOf([
        null,
        'nope',
        { ns: 'llm-pi-ai' },
        { ns: 'llm-pi-ai', value: { providers: 'nope' } },
        { ns: 'llm-pi-ai', value: { providers: { 'opencode-go': null, commandcode: { apiKeyEnv: '' } } } },
        { ns: 'llm-pi-ai', value: { providers: { commandcode: { apiKeyEnv: 'COMMANDCODE_API_KEY', baseURL: 42 } } } },
        { ns: 'llm-pi-ai', value: { providers: { commandcode: { apiKeyEnv: 'IGNORED_KEY' } } } },
      ]),
      credentials: credentialsOf(TWO_KEYS),
    })
    const value = (await serve(captured)).value as { providers: { id: string }[] }
    assert.deepEqual(value.providers.map(provider => provider.id), ['commandcode'])
  })

  test('a rejecting resolver, a non-string key, and unconfigured providers never reach the upstream', async () => {
    const log: FetchLog[] = []
    stubFetcher({}, log)
    const unconfigured = mounted({ settings: settingsOf({ 'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY' } }), credentials: credentialsOf({}) })
    assert.equal((await serve(unconfigured.captured)).value, null)

    const rejecting = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: credentialsOf(TWO_KEYS, 'throws') })
    assert.equal((await serve(rejecting.captured)).value, null)

    const nonString = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: credentialsOf({ OPENCODE_API_KEY: 42, COMMANDCODE_API_KEY: 42 }) })
    assert.equal((await serve(nonString.captured)).value, null)

    const noResolver = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: {} })
    assert.equal((await serve(noResolver.captured)).value, null)
    assert.equal(log.length, 0)
  })

  test('an upstream rejection, a transport failure, or malformed JSON drops that provider only', async () => {
    setQuotaFetcher(async (url) => {
      if (url.includes('/zen/go/v1/usage')) return { ok: false, status: 401, json: async () => ({}) } as unknown as Response
      return { ok: true, status: 200, json: async () => COMMANDCODE_BODY } as unknown as Response
    })
    const rejected = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: credentialsOf(TWO_KEYS) })
    assert.deepEqual(((await serve(rejected.captured)).value as { providers: { id: string }[] }).providers.map(provider => provider.id), ['commandcode'])

    setQuotaFetcher(async () => { throw new Error('down') })
    const down = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: credentialsOf(TWO_KEYS) })
    assert.equal((await serve(down.captured)).value, null)

    setQuotaFetcher(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }) as unknown as Response)
    const badJson = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: credentialsOf(TWO_KEYS) })
    assert.equal((await serve(badJson.captured)).value, null)
  })

  test('the built-in fetcher serves the route when no test fetcher is installed', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/zen/go/v1/usage') ? OPENCODE_BODY : COMMANDCODE_BODY),
    })) as unknown as typeof fetch
    try {
      setQuotaFetcher(null)
      const { captured } = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: credentialsOf(TWO_KEYS) })
      const value = (await serve(captured)).value as { providers: { id: string }[] }
      assert.deepEqual(value.providers.map(provider => provider.id), ['opencode-go', 'commandcode'])
    } finally {
      globalThis.fetch = original
    }
  })

  test('concurrent reads share the in-flight probe for one provider', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    setQuotaFetcher(async (url) => {
      calls++
      await gate
      const body = url.includes('/zen/go/v1/usage') ? OPENCODE_BODY : COMMANDCODE_BODY
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    })
    const { ctx, captured } = mounted({ settings: settingsOf(TWO_PROVIDERS), credentials: credentialsOf(TWO_KEYS) })
    const first = serve(captured)
    const second = serve(captured)
    release()
    await Promise.all([first, second])
    assert.equal(calls, 2)
    assert.notEqual(ctx, undefined)
  })
})
