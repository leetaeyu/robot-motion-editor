import { test, expect, type Page } from '@playwright/test'

const menu = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '파일', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

const motionTracks = (page: Page) => page.evaluate(() =>
  (window as any).__editor.getState().project.sequence.tracks.filter((t: any) => t.kind === 'motion').length as number)

test('compare: second CSV is an asset only; 비교 opens a preview pane without touching the project; close removes it', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showDirectoryPicker })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const joints = await page.evaluate(() => (window as any).__editor.getState().defs.g1.joints.map((j: { name: string }) => j.name) as string[])
  const head = ['frequency(fps)', 'RobotType', 'DOF Number', 'time(ms)', 'position X(m)', 'position Y(m)', 'position Z(m)',
    'quaternion X', 'quaternion Y', 'quaternion Z', 'quaternion W', ...joints].join(',') + ','
  const csv = (k: number) => Buffer.from([head, ...Array.from({ length: 60 }, (_, i) =>
    [50, 0, 29, Math.round(i * 1000 / 50), (0.01 * i).toFixed(6), '0.000000', '0.790000', '0', '0', '0', '1',
      ...joints.map((_, j) => (0.02 * k * Math.sin(i / 9 + j)).toFixed(6))].join(',') + ',')].join('\n') + '\n')

  const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'CSV 가져오기')])
  await fc.setFiles([{ name: 'a.csv', mimeType: 'text/csv', buffer: csv(1) }, { name: 'b.csv', mimeType: 'text/csv', buffer: csv(2) }])
  await expect(page.locator('.pp-card')).toHaveCount(2)
  await expect(page.locator('.pp-msg')).toContainText('클립 2개를 가져왔습니다')
  expect(await motionTracks(page)).toBe(1)
  expect(await page.evaluate(() => (window as any).__editor.getState().project.sequence.tracks.find((t: any) => t.kind === 'motion').items.length)).toBe(1)
  await expect(page.locator('.pp-card').nth(1)).toContainText('사용 0')

  await page.evaluate(() => { const s = (window as any).__editor.getState(); (window as any).__p0 = s.project; (window as any).__d0 = s.dirty })
  await page.locator('.pp-card').nth(1).getByRole('button', { name: '⇄ 비교' }).click()
  const pane = page.getByRole('region', { name: '비교 프리뷰' })
  await expect(pane).toContainText('비교 프리뷰 · b (G1)')
  await expect.poll(() => pane.locator('canvas').evaluate(c => c.getBoundingClientRect().width)).toBeGreaterThan(0)
  expect(await motionTracks(page)).toBe(1)
  expect(await page.evaluate(() => { const s = (window as any).__editor.getState(); return s.project === (window as any).__p0 && s.dirty === (window as any).__d0 })).toBe(true)
  const main = page.getByRole('region', { name: '로봇 프리뷰' }).locator('canvas')
  expect(await main.evaluate(c => c.getBoundingClientRect().width)).toBeGreaterThan(0)

  // the row divider moves with the arrow keys, clamped at 15%
  const sep = page.getByRole('separator', { name: '비교 프리뷰 분할 1' })
  expect(await sep.getAttribute('aria-valuenow')).toBe('50')
  await sep.focus(); await page.keyboard.press('ArrowRight')
  expect(await sep.getAttribute('aria-valuenow')).toBe('52')

  await pane.getByRole('button', { name: '비교 닫기' }).click()
  await expect(pane).toHaveCount(0)

  // right-click menu: 삭제 of a clip in use is rejected with the usual message; Esc closes
  await page.locator('.pp-card').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: '삭제' }).click()
  await expect(page.locator('.pp-msg', { hasText: '시퀀스에서 쓰는 클립은 삭제할 수 없습니다' })).toBeVisible()
  await page.locator('.pp-card').first().focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('menu', { name: '에셋' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: '에셋' })).toHaveCount(0)
  expect(errors).toEqual([])
})
