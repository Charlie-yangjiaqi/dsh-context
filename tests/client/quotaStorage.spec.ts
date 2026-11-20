// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { readProviderQuota, resetProviderQuota } from '../../src/client/quota'

describe('quota storage access', () => {
  test('a throwing localStorage getter degrades to no cache', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied') },
    })
    try {
      resetProviderQuota()
      assert.equal(readProviderQuota(() => {}), null)
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage')
      resetProviderQuota()
    }
  })
})
