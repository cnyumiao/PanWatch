import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import InteractiveKline from '@panwatch/biz-ui/components/InteractiveKline'
import { MarketColorProvider } from '@/hooks/use-market-colors'

// 25 synthetic daily bars so a 20-period BOLL has six plotted points.
const { klineRows } = vi.hoisted(() => ({
  klineRows: Array.from({ length: 25 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    open: 100 + i,
    close: 100 + i + (i % 2),
    high: 100 + i + 2,
    low: 100 + i - 1,
    volume: 1000 + i * 10,
  })),
}))

vi.mock('@panwatch/api', async (original) => ({
  ...await original<typeof import('@panwatch/api')>(),
  fetchAPI: vi.fn().mockResolvedValue({ symbol: '601288', market: 'CN', days: 120, klines: klineRows }),
}))

type SeriesRecord = { kind: string; options: Record<string, unknown>; data: Array<{ value: number }> }
type ChartRecord = { series: SeriesRecord[]; removed: boolean }

const charts: ChartRecord[] = []

function addSeries(record: ChartRecord, kind: string, options: Record<string, unknown>) {
  const entry: SeriesRecord = { kind, options, data: [] }
  record.series.push(entry)
  return {
    setData: (rows: SeriesRecord['data']) => { entry.data = rows },
    createPriceLine: () => undefined,
  }
}

function createChartStub() {
  const record: ChartRecord = { series: [], removed: false }
  charts.push(record)
  return {
    addCandlestickSeries: (options: Record<string, unknown>) => addSeries(record, 'candle', options),
    addLineSeries: (options: Record<string, unknown>) => addSeries(record, 'line', options),
    addHistogramSeries: (options: Record<string, unknown>) => addSeries(record, 'histogram', options),
    priceScale: () => ({ applyOptions: () => undefined }),
    timeScale: () => ({
      setVisibleRange: () => undefined,
      setVisibleLogicalRange: () => undefined,
      subscribeVisibleTimeRangeChange: () => undefined,
      applyOptions: () => undefined,
    }),
    subscribeCrosshairMove: () => undefined,
    applyOptions: () => undefined,
    remove: () => { record.removed = true },
  }
}

const bollSeries = (record: ChartRecord) =>
  record.series.filter(series => series.kind === 'line' && String(series.options.color).includes('217, 70, 239'))

// The moving averages (price + volume) are the only line series on the main
// chart besides BOLL; MACD lives on its own chart.
const maSeries = (record: ChartRecord) =>
  record.series.filter(series => series.kind === 'line' && !String(series.options.color).includes('217, 70, 239'))

// Each re-render creates the main chart first and the MACD/RSI charts after it,
// so pick the newest chart that actually holds the candles.
const latestMainChart = () => [...charts].reverse().find(record => record.series.some(series => series.kind === 'candle'))

beforeEach(() => {
  charts.length = 0
  vi.stubGlobal('LightweightCharts', { createChart: createChartStub })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function renderChart() {
  return render(<MarketColorProvider><InteractiveKline symbol="601288" market="CN" initialDays="120" /></MarketColorProvider>)
}

it('plots BOLL upper/middle/lower bands on the candlestick chart', async () => {
  renderChart()
  await waitFor(() => expect(charts.length).toBeGreaterThan(0))

  const mainChart = charts[0]
  const [upper, mid, lower] = bollSeries(mainChart)
  expect(upper && mid && lower).toBeTruthy()

  const closes = klineRows.map(row => row.close)
  const window = closes.slice(-20)
  const expectedMid = window.reduce((sum, value) => sum + value, 0) / 20
  const expectedStd = Math.sqrt(window.reduce((sum, value) => sum + (value - expectedMid) ** 2, 0) / 20)
  const last = (series: SeriesRecord) => series.data[series.data.length - 1].value

  expect(upper.data).toHaveLength(6)
  expect(mid.data).toHaveLength(6)
  expect(lower.data).toHaveLength(6)
  expect(last(mid)).toBeCloseTo(expectedMid, 6)
  expect(last(upper)).toBeCloseTo(expectedMid + 2 * expectedStd, 6)
  expect(last(lower)).toBeCloseTo(expectedMid - 2 * expectedStd, 6)
  expect(last(upper)).toBeGreaterThan(last(mid))
  expect(last(lower)).toBeLessThan(last(mid))
})

it('draws all three BOLL bands as solid lines', async () => {
  renderChart()
  await waitFor(() => expect(charts.length).toBeGreaterThan(0))

  const mainChart = latestMainChart()
  expect(mainChart).toBeTruthy()
  const bands = bollSeries(mainChart as ChartRecord)
  expect(bands).toHaveLength(3)
  for (const band of bands) {
    // 0 = LineStyle.Solid in lightweight-charts; dashed (2) was the old default.
    expect(band.options.lineStyle).toBe(0)
  }
})

it('hides moving averages by default and plots them after the MA toggle', async () => {
  renderChart()
  await waitFor(() => expect(charts.length).toBeGreaterThan(0))

  expect(maSeries(latestMainChart() as ChartRecord)).toHaveLength(0)

  fireEvent.click(screen.getByRole('button', { name: '均线' }))
  await waitFor(() => expect(maSeries(latestMainChart() as ChartRecord)).toHaveLength(5))
})

it('removes the bands when the BOLL toggle is switched off', async () => {
  renderChart()
  await waitFor(() => expect(charts.length).toBeGreaterThan(0))
  expect(bollSeries(latestMainChart() as ChartRecord)).toHaveLength(3)

  fireEvent.click(screen.getByRole('button', { name: '布林线' }))
  await waitFor(() => expect(bollSeries(latestMainChart() as ChartRecord)).toHaveLength(0))
})
