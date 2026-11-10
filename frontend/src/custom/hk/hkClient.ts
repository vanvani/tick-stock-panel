/** 港股看板专用的端点封装；完全独立于 lib/api 的 A 股接口。 */

const BASE = '/api/custom/hk-market'

export interface HkMeta {
  source: string
  realtime: boolean
  minute_bars: boolean
  daily_bars: boolean
  turnover_is_estimate: boolean
  notes: string[]
  default_basket: string[]
}

export interface HkInstrument {
  symbol: string
  name: string
}

export interface HkBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  name?: string
  pct?: number | null
  turnover_est?: number
  ma5?: number | null
  ma10?: number | null
  ma20?: number | null
  ma60?: number | null
  macd_dif?: number | null
  macd_dea?: number | null
  macd_hist?: number | null
  rsi_14?: number | null
}

export interface HkQuote {
  symbol: string
  name: string
  date: string
  close: number
  open: number
  high: number
  low: number
  prev_close: number | null
  pct: number | null
  amplitude: number | null
  volume: number
  turnover_est: number
  chg_5d: number | null
  chg_20d: number | null
  chg_60d: number | null
  chg_ytd: number | null
  high_52w: number | null
  low_52w: number | null
  ma5: number | null
  ma10: number | null
  ma20: number | null
  ma60: number | null
  rsi_14: number | null
  macd_dif: number | null
  macd_dea: number | null
  macd_hist: number | null
  bars: number
}

export interface HkOverview {
  items: HkQuote[]
  failed: number
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  // 首次拉一篮子时上游限速会串行等 1 秒/只，60 秒足够；命中缓存则为毫秒级
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 90_000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(`${BASE}${path}`, { signal: controller.signal })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      try {
        const body = await response.json()
        if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
      } catch { /* 非 JSON 响应直接用状态码 */ }
      throw new Error(detail)
    }
    return (await response.json()) as T
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export const hkApi = {
  meta: () => request<HkMeta>('/meta'),
  overview: (symbols: string[]) =>
    request<HkOverview>(`/overview?symbols=${encodeURIComponent(symbols.join(','))}`),
  quote: (symbol: string, signal?: AbortSignal) =>
    request<HkQuote>(`/quote?symbol=${encodeURIComponent(symbol)}`, signal),
  kline: (symbol: string, count: number, signal?: AbortSignal) =>
    request<{ symbol: string; name: string; bars: HkBar[]; total: number }>(
      `/kline?symbol=${encodeURIComponent(symbol)}&count=${count}`,
      signal,
    ),
  search: (query: string, signal?: AbortSignal) =>
    request<{ total: number; items: HkInstrument[] }>(
      `/instruments?q=${encodeURIComponent(query)}&limit=20`,
      signal,
    ),
}

export const hkKeys = {
  meta: ['custom', 'hk-market', 'meta'] as const,
  overview: (symbols: string[]) => ['custom', 'hk-market', 'overview', symbols.join(',')] as const,
  quote: (symbol: string) => ['custom', 'hk-market', 'quote', symbol] as const,
  kline: (symbol: string, count: number) => ['custom', 'hk-market', 'kline', symbol, count] as const,
  search: (q: string) => ['custom', 'hk-market', 'search', q] as const,
}
