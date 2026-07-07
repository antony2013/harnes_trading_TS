// Pure helpers for the backtest-data module. No DB / Upstox imports so this
// module is safe to import for unit verification without side effects.

const DAY = 86_400_000 // ms

/** Canonical timeframe label stored in the candles table. */
export function timeframeLabel(
  source: 'v2' | 'v3',
  interval: string,
  unit?: string,
): string {
  // v2: raw interval string ('1minute','30minute','day','week','month').
  // v3: composed as '{interval}{unit}' ('1minutes','1days', ...).
  if (source === 'v2') return interval
  return `${interval}${unit}`
}

/** Coerce an Upstox candle timestamp (ISO string or epoch number) to epoch ms. */
export function toEpochMs(v: string | number): number {
  if (typeof v === 'number') {
    // Upstox sometimes returns seconds; anything below year-2001 in ms is seconds.
    return v > 1e12 ? v : v * 1000
  }
  return new Date(v).getTime()
}

/** Epoch ms -> 'YYYY-MM-DD' (UTC) for Upstox from_date / to_date params. */
export function toDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Chunk size (ms) for a timeframe, matching Upstox per-call lookback limits. */
export function chunkSizeMs(timeframe: string): number {
  // minute-level -> 1 month
  if (timeframe === '1minute') return 30 * DAY
  const minuteMatch = /^(\d+)minutes$/.exec(timeframe)
  if (minuteMatch && Number(minuteMatch[1]) <= 60) return 30 * DAY
  // 30min / hour / day -> 1 year
  if (
    timeframe === '30minute' ||
    timeframe === 'day' ||
    /hours$/.test(timeframe) ||
    /days$/.test(timeframe)
  ) {
    return 365 * DAY
  }
  // week / month -> 10 years
  if (timeframe === 'week' || timeframe === 'month') return 10 * 365 * DAY
  // unknown -> safe default 1 year
  return 365 * DAY
}

/** Split [fromMs, toMs] into contiguous chunks of <= sizeMs. */
export function chunkRange(
  fromMs: number,
  toMs: number,
  sizeMs: number,
): Array<[number, number]> {
  if (toMs < fromMs) return []
  const chunks: Array<[number, number]> = []
  let cur = fromMs
  while (cur <= toMs) {
    const end = Math.min(cur + sizeMs, toMs)
    chunks.push([cur, end])
    if (end === toMs) break
    cur = end + 1
  }
  return chunks
}