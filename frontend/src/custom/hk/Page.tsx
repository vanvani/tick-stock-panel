/**
 * 港股看板（只读）。
 *
 * 定位：A 股工作台旁边的"邻居窗口"，只看港股日线，不掺和策略/回测/撮合。
 * 数据：TickFlow 免费层 —— 最近一个交易日收盘、日 K、前复权；
 *       不提供实时与分钟 K，成交额由「收盘 × 成交量」估算，界面一律标「估」。
 * 口径：涨红跌绿沿用全站语义色；代码 5 位 + .HK（A 股的 6 位规范在这里不适用）。
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, RefreshCw, Search, Star, X } from 'lucide-react'
import { EChartsCandlestick, type OHLC } from '@/components/EChartsCandlestick'
import { PageHeader } from '@/components/PageHeader'
import { cn } from '@/lib/cn'
import { fmtVolume } from '@/lib/format'
import { hkApi, hkKeys, type HkBar, type HkQuote } from './hkClient'

const WATCH_KEY = 'hk-market:watchlist'
const FALLBACK_BASKET = ['00700.HK', '00005.HK', '00939.HK', '03690.HK', '09988.HK', '01810.HK']
const RANGES = [
  { label: '3月', count: 60 },
  { label: '半年', count: 120 },
  { label: '1年', count: 250 },
] as const

function readWatch(): string[] {
  try {
    const raw = window.localStorage.getItem(WATCH_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string' && s.endsWith('.HK'))
  } catch { /* 损坏就回退到默认篮子 */ }
  return FALLBACK_BASKET
}

function writeWatch(symbols: string[]) {
  try {
    window.localStorage.setItem(WATCH_KEY, JSON.stringify(symbols))
  } catch { /* 隐私模式下写失败不影响本次浏览 */ }
}

/** 后端口径：pct 已是百分数（-0.33 表示 -0.33%）。 */
function pctText(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

function trendClass(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v) || v === 0) return 'text-muted'
  return v > 0 ? 'text-bull' : 'text-bear'
}

function priceText(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)
}

/** 成交额（估算）：港股多是百亿级，直接按亿/万亿展示。 */
function moneyText(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v) || v === 0) return '—'
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}万亿`
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(0)}万`
  return v.toFixed(0)
}

function toOHLC(bars: HkBar[]): OHLC[] {
  return bars.map(b => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    ma5: b.ma5 ?? null,
    ma10: b.ma10 ?? null,
    ma20: b.ma20 ?? null,
    ma60: b.ma60 ?? null,
    macd_dif: b.macd_dif ?? null,
    macd_dea: b.macd_dea ?? null,
    macd_hist: b.macd_hist ?? null,
    rsi_14: b.rsi_14 ?? null,
  }))
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-btn bg-base px-2.5 py-1.5">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={cn('font-mono text-xs text-foreground', className)}>{value}</div>
    </div>
  )
}

export function HkMarket() {
  const [watch, setWatch] = useState<string[]>(() => readWatch())
  const [selected, setSelected] = useState(() => readWatch()[0] ?? '00700.HK')
  const [rangeCount, setRangeCount] = useState<number>(120)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  const meta = useQuery({ queryKey: hkKeys.meta, queryFn: () => hkApi.meta(), staleTime: 60 * 60 * 1000 })

  const overview = useQuery({
    queryKey: hkKeys.overview(watch),
    queryFn: () => hkApi.overview(watch),
    enabled: watch.length > 0,
    staleTime: 5 * 60 * 1000,
  })

  const search = useQuery({
    queryKey: hkKeys.search(debounced),
    queryFn: ({ signal }) => hkApi.search(debounced, signal),
    enabled: debounced.length > 0,
    staleTime: 5 * 60 * 1000,
  })

  const quote = useQuery({
    queryKey: hkKeys.quote(selected),
    queryFn: ({ signal }) => hkApi.quote(selected, signal),
    enabled: Boolean(selected),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })

  const kline = useQuery({
    queryKey: hkKeys.kline(selected, rangeCount),
    queryFn: ({ signal }) => hkApi.kline(selected, rangeCount, signal),
    enabled: Boolean(selected),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })

  const rows: HkQuote[] = useMemo(() => overview.data?.items ?? [], [overview.data])
  const rowsBySymbol = useMemo(() => new Map(rows.map(r => [r.symbol, r])), [rows])
  const chartData = useMemo(() => (kline.data ? toOHLC(kline.data.bars) : []), [kline.data])

  function addToWatch(symbol: string) {
    setWatch(prev => {
      if (prev.includes(symbol)) return prev
      const next = [...prev, symbol]
      writeWatch(next)
      return next
    })
    setSelected(symbol)
    setQuery('')
    setDebounced('')
  }

  function removeFromWatch(symbol: string) {
    setWatch(prev => {
      const next = prev.filter(s => s !== symbol)
      writeWatch(next)
      return next
    })
  }

  function refreshAll() {
    void meta.refetch()
    void overview.refetch()
    void quote.refetch()
    void kline.refetch()
  }

  const q = quote.data
  const loadingQuote = quote.isPending
  const metaNotes = meta.data?.notes ?? []

  return (
    <div className="flex h-full flex-col bg-base">
      <PageHeader
        title="港股看板"
        subtitle={meta.data ? `${meta.data.source} · 日线收盘口径 · 非实时` : 'TickFlow 免费层 · 日线收盘口径'}
        right={
          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] text-muted md:inline">成交额为估算值</span>
            <button
              onClick={refreshAll}
              className="inline-flex items-center gap-1.5 rounded-btn border border-border px-2.5 py-1 text-xs text-secondary hover:bg-elevated"
            >
              <RefreshCw className="h-3 w-3" /> 刷新
            </button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-3">
        <aside className="flex w-[284px] shrink-0 flex-col rounded-card border border-border bg-surface p-2">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="代码或名称，如 00700 / 腾讯"
              className="w-full rounded-btn border border-border bg-base py-1.5 pl-7 pr-6 text-xs text-foreground outline-none placeholder:text-muted focus:border-accent"
            />
            {query && (
              <button
                onClick={() => { setQuery(''); setDebounced('') }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {debounced ? (
              <div className="space-y-0.5">
                {search.isPending && <div className="px-2 py-3 text-xs text-muted">搜索中…</div>}
                {search.isError && (
                  <div className="px-2 py-3 text-xs text-danger">{(search.error as Error).message}</div>
                )}
                {search.data?.items.length === 0 && (
                  <div className="px-2 py-3 text-xs text-muted">没有匹配的港股</div>
                )}
                {search.data?.items.map(item => {
                  const inWatch = watch.includes(item.symbol)
                  return (
                    <button
                      key={item.symbol}
                      onClick={() => addToWatch(item.symbol)}
                      className="flex w-full items-center justify-between gap-2 rounded-btn px-2 py-1.5 text-left hover:bg-elevated"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs text-foreground">{item.name}</span>
                        <span className="font-mono text-[10px] text-muted">{item.symbol}</span>
                      </span>
                      {inWatch ? (
                        <span className="shrink-0 text-[10px] text-muted">已加</span>
                      ) : (
                        <Plus className="h-3 w-3 shrink-0 text-accent" />
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <>
                <div className="mb-1 flex items-center gap-1 px-1 text-[10px] text-muted">
                  <Star className="h-3 w-3" /> 自选（{watch.length}）
                </div>
                {overview.isPending && <div className="px-2 py-3 text-xs text-muted">加载中…</div>}
                {overview.isError && (
                  <div className="px-2 py-3 text-xs text-danger">
                    {(overview.error as Error).message}
                    <button onClick={() => overview.refetch()} className="ml-1 underline">重试</button>
                  </div>
                )}
                {watch.length === 0 && (
                  <div className="px-2 py-3 text-xs text-muted">自选为空，搜索代码添加。</div>
                )}
                {watch.map(symbol => {
                  const row = rowsBySymbol.get(symbol)
                  const active = symbol === selected
                  return (
                    <div
                      key={symbol}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelected(symbol)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelected(symbol) }}
                      className={cn(
                        'group flex cursor-pointer items-center justify-between gap-2 rounded-btn px-2 py-1.5',
                        active ? 'bg-accent/15' : 'hover:bg-elevated',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {row?.name ?? symbol}
                        </span>
                        <span className="font-mono text-[10px] text-muted">{symbol}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="text-right">
                          <span className={cn('block font-mono text-[11px]', trendClass(row?.pct))}>
                            {pctText(row?.pct)}
                          </span>
                          <span className="block font-mono text-[10px] text-muted">{priceText(row?.close)}</span>
                        </span>
                        <button
                          onClick={e => { e.stopPropagation(); removeFromWatch(symbol) }}
                          title="移出自选"
                          className="opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    </div>
                  )
                })}
              </>
            )}
          </div>

          {metaNotes.length > 0 && (
            <div className="mt-2 border-t border-border pt-2 text-[10px] leading-relaxed text-muted">
              {metaNotes.slice(0, 3).map(note => <div key={note}>· {note}</div>)}
            </div>
          )}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto rounded-card border border-border bg-surface p-3">
          {loadingQuote && (
            <div className="flex items-center gap-2 py-10 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> 首次拉取日线（免费接口 1 秒/只，约需数秒）…
            </div>
          )}

          {quote.isError && (
            <div className="rounded-card bg-elevated p-4 text-sm text-danger">
              {selected} 加载失败：{(quote.error as Error).message}
              <button onClick={() => quote.refetch()} className="ml-2 underline">重试</button>
            </div>
          )}

          {q && (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-lg font-semibold text-foreground">{q.name}</h2>
                    <span className="font-mono text-xs text-muted">{q.symbol}</span>
                  </div>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className={cn('font-mono text-2xl font-semibold', trendClass(q.pct))}>
                      {priceText(q.close)}
                    </span>
                    <span className={cn('font-mono text-sm', trendClass(q.pct))}>
                      {pctText(q.pct)}
                      {q.prev_close != null && (
                        <span className="ml-1 text-xs text-muted">
                          ({q.close >= q.prev_close ? '+' : ''}
                          {priceText(q.close - q.prev_close)})
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-muted">截至 {q.date} 收盘</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {RANGES.map(r => (
                    <button
                      key={r.count}
                      onClick={() => setRangeCount(r.count)}
                      className={cn(
                        'rounded-btn px-2 py-1 text-xs',
                        rangeCount === r.count ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-elevated',
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
                <Metric label="成交额(估)" value={moneyText(q.turnover_est)} />
                <Metric label="成交量" value={fmtVolume(q.volume)} />
                <Metric label="振幅" value={pctText(q.amplitude)} />
                <Metric label="52周高/低" value={`${priceText(q.high_52w)} / ${priceText(q.low_52w)}`} />
                <Metric label="20日" value={pctText(q.chg_20d)} className={trendClass(q.chg_20d)} />
                <Metric label="60日" value={pctText(q.chg_60d)} className={trendClass(q.chg_60d)} />
                <Metric label="年初至今" value={pctText(q.chg_ytd)} className={trendClass(q.chg_ytd)} />
              </div>

              {kline.isPending && (
                <div className="flex items-center gap-2 py-8 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" /> K 线加载中…
                </div>
              )}
              {kline.isError && (
                <div className="rounded-card bg-elevated p-4 text-sm text-danger">
                  K 线加载失败：{(kline.error as Error).message}
                  <button onClick={() => kline.refetch()} className="ml-2 underline">重试</button>
                </div>
              )}
              {chartData.length > 0 && (
                <EChartsCandlestick
                  data={chartData}
                  height={440}
                  showMA
                  showInfoBar
                  showMarkers={false}
                  symbol={q.symbol}
                  visibleBars={rangeCount > 60 ? rangeCount : 60}
                />
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-btn bg-base px-3 py-2 text-[11px] text-muted">
                <span>MA5 <b className="font-mono text-foreground">{priceText(q.ma5)}</b></span>
                <span>MA10 <b className="font-mono text-foreground">{priceText(q.ma10)}</b></span>
                <span>MA20 <b className="font-mono text-foreground">{priceText(q.ma20)}</b></span>
                <span>MA60 <b className="font-mono text-foreground">{priceText(q.ma60)}</b></span>
                <span>
                  RSI14{' '}
                  <b className={cn('font-mono', q.rsi_14 == null ? 'text-foreground' : q.rsi_14 > 70 ? 'text-bull' : q.rsi_14 < 30 ? 'text-bear' : 'text-foreground')}>
                    {q.rsi_14 == null ? '—' : q.rsi_14.toFixed(1)}
                  </b>
                </span>
                <span>
                  MACD{' '}
                  <b className={cn('font-mono', trendClass(q.macd_hist))}>{priceText(q.macd_hist)}</b>
                </span>
                <span className="text-muted/70">共 {q.bars} 根日线 · 前复权</span>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
