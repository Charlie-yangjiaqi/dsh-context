import { useEffect, useState, type ReactElement } from 'react'
import type { QuotaProvider, QuotaSnapshot } from '../../shared/types'
import { readProviderQuota } from '../quota'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

const REFRESH_MS = 5 * 60 * 1000

const WINDOW_KEYS: Record<string, string> = {
  rolling: 'quota.window.rolling',
  fiveHour: 'quota.window.fiveHour',
  weekly: 'quota.window.weekly',
  monthly: 'quota.window.monthly',
}

function tightestOf(provider: QuotaProvider): number {
  let percent = 0
  for (const window of provider.windows) if (window.percent > percent) percent = window.percent
  return percent
}

export function makeQuotaCapsule(ctx: ClientCtx, kit: ViewKit): () => ReactElement | null {
  const { t } = kit
  function QuotaChip({ provider }: { provider: QuotaProvider }): ReactElement {
    const lines: string[] = []
    for (const window of provider.windows) {
      const label = t(WINDOW_KEYS[window.key] ?? 'quota.window.rolling')
      lines.push(t('quota.tip.window', { window: label, p: Math.round(window.percent) }))
    }
    if (provider.remaining !== undefined) lines.push(t('quota.tip.credits', { n: Math.round(provider.remaining) }))
    const tip = lines.join('\n')
    const remaining = Math.max(0, Math.round(100 - tightestOf(provider)))
    return (
      <a
        className="lc-ov-quota"
        href={provider.dashboard === '' ? undefined : provider.dashboard}
        target="_blank"
        rel="noreferrer"
        aria-label={tip === '' ? provider.label : tip}
        {...(tip === '' ? {} : { 'data-lc-tip': tip, 'data-lc-tip-side': 'bottom' })}
      >
        <span className="lc-ov-quota-label">{provider.label}</span>
        <span className="lc-ov-quota-value">{remaining}%</span>
      </a>
    )
  }
  return function QuotaCapsule(): ReactElement | null {
    const [quota, setQuota] = useState<QuotaSnapshot | null>(() => readProviderQuota((value) => { setQuota(value) }))
    useEffect(() => {
      const timer = setInterval(() => {
        readProviderQuota((value) => { setQuota(value) })
      }, REFRESH_MS)
      return () => { clearInterval(timer) }
    }, [])
    if (quota === null) return null
    return (
      <>
        {quota.providers.map(provider => <QuotaChip key={provider.id} provider={provider} />)}
      </>
    )
  }
}
