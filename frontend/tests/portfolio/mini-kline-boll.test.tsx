import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { insightApi } from '@panwatch/api'
import StockInsightModal from '@panwatch/biz-ui/components/stock-insight-modal'
import { MarketColorProvider } from '@/hooks/use-market-colors'

// 36 daily bars: BOLL(20) has history for every one of the 30 visible bars.
const { klineRows } = vi.hoisted(() => ({
  klineRows: Array.from({ length: 36 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    open: 100 + i,
    close: 100 + i + (i % 4 === 0 ? -1.5 : 0.8),
    high: 100 + i + 2.5,
    low: 100 + i - 2.5,
    volume: 1000 + i * 10,
  })),
}))

vi.mock('@panwatch/api', async (original) => ({
  ...await original<typeof import('@panwatch/api')>(),
  insightApi: {
    quote: vi.fn().mockResolvedValue({ symbol: '601288', name: '农业银行', market: 'CN', current_price: 135 }),
    klineSummary: vi.fn().mockReturnValue(new Promise(() => {})),
    klines: vi.fn().mockResolvedValue({ symbol: '601288', market: 'CN', klines: klineRows }),
    portfolioSummary: vi.fn().mockResolvedValue({ accounts: [] }),
    suggestions: vi.fn().mockResolvedValue([]), news: vi.fn().mockResolvedValue([]), history: vi.fn().mockResolvedValue([]),
  },
  stocksApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@panwatch/biz-ui/components/stock-price-alert-panel', () => ({ default: () => null }))
vi.mock('@panwatch/biz-ui/components/add-position-calculator', () => ({ default: () => null }))
afterEach(() => { cleanup(); localStorage.clear() })

function renderModal() {
  return render(<MemoryRouter><MarketColorProvider><StockInsightModal open onOpenChange={vi.fn()} symbol="601288" market="CN" stockName="农业银行" /></MarketColorProvider></MemoryRouter>)
}

it('overlays solid BOLL bands on the mini chart with the latest band values', async () => {
  renderModal()
  await screen.findByTitle('点击进入交互式K线')

  // Three band polylines (upper / mid / lower) are overlaid on the candles in
  // the mini chart (the modal may render other sparklines elsewhere).
  const miniChart = document.querySelector('svg[viewBox="0 0 320 120"]')
  expect(miniChart).toBeTruthy()
  const polylines = Array.from(miniChart?.querySelectorAll('polyline') ?? [])
  expect(polylines).toHaveLength(3)
  for (const line of polylines) {
    expect(line.getAttribute('fill')).toBe('none')
  }

  const closes = klineRows.map(row => row.close)
  const window = closes.slice(-20)
  const expectedMid = window.reduce((sum, value) => sum + value, 0) / 20
  const expectedStd = Math.sqrt(window.reduce((sum, value) => sum + (value - expectedMid) ** 2, 0) / 20)
  const expected = {
    upper: (expectedMid + 2 * expectedStd).toFixed(2),
    mid: expectedMid.toFixed(2),
    lower: (expectedMid - 2 * expectedStd).toFixed(2),
  }

  // Legend shows the latest upper / mid / lower values.
  const legend = screen.getByTestId('mini-kline-boll-legend')
  expect(legend.textContent).toContain(expected.upper)
  expect(legend.textContent).toContain(expected.mid)
  expect(legend.textContent).toContain(expected.lower)

  // BOLL is computed over all 36 fetched bars, so the bands are already warm for
  // the 30 visible bars: index 19 (first valid point) through 35 = 17 points.
  for (const line of polylines) {
    expect(line.getAttribute('points')?.trim().split(/\s+/)).toHaveLength(17)
  }
})
