/** Shared K-line indicator math and BOLL styling for the interactive and mini charts. */

export function sma(values: number[], period: number): Array<number | null> {
  if (period <= 1) return values.map(v => v)
  const out: Array<number | null> = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (values.length === 0) return out
  const k = 2 / (period + 1)
  let prev: number | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (prev == null) {
      prev = v
      out[i] = v
      continue
    }
    prev = v * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

export function computeMacd(closes: number[]) {
  const e12 = ema(closes, 12)
  const e26 = ema(closes, 26)
  const macd: Array<number | null> = closes.map((_, i) => {
    const a = e12[i]
    const b = e26[i]
    if (a == null || b == null) return null
    return a - b
  })
  const macdVals = macd.map(v => (v == null ? 0 : v))
  const signal = ema(macdVals, 9)
  const hist: Array<number | null> = macd.map((v, i) => {
    if (v == null || signal[i] == null) return null
    return v - (signal[i] as number)
  })
  return { macd, signal, hist }
}

export function computeBoll(closes: number[], period = 20, numStd = 2) {
  const mid: Array<number | null> = new Array(closes.length).fill(null)
  const upper: Array<number | null> = new Array(closes.length).fill(null)
  const lower: Array<number | null> = new Array(closes.length).fill(null)
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < closes.length; i++) {
    const v = closes[i]
    sum += v
    sumSq += v * v
    if (i >= period) {
      const old = closes[i - period]
      sum -= old
      sumSq -= old * old
    }
    if (i >= period - 1) {
      const mean = sum / period
      // Population standard deviation (divide by period), matching the backend BOLL.
      const variance = Math.max(0, sumSq / period - mean * mean)
      const std = Math.sqrt(variance)
      mid[i] = mean
      upper[i] = mean + numStd * std
      lower[i] = mean - numStd * std
    }
  }
  return { mid, upper, lower }
}

export function computeRsi(closes: number[], period = 6): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null)
  if (closes.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gain += diff
    else loss += -diff
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const g = diff > 0 ? diff : 0
    const l = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

/** Purple BOLL palette shared by the interactive chart and the mini chart. */
export const BOLL_COLORS = {
  upper: 'rgba(217, 70, 239, 0.8)',
  mid: 'rgba(217, 70, 239, 0.55)',
  lower: 'rgba(217, 70, 239, 0.8)',
} as const
