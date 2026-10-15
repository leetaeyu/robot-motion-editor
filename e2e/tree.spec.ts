import { test, expect } from '@playwright/test'

const items = (page: import('@playwright/test').Page) => page.evaluate(() =>
  (window as any).__editor.getState().project.sequence.tracks.find((t: any) => t.kind === 'motion').items.length as number)

test('tree: expand a track, click a child row → clip preview; 기본자세 세팅 bakes the rest pose in place', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showDirectoryPicker })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const joints = await page.evaluate(() => (window as any).__editor.getState().defs.g1.joints.map((j: { name: string }) => j.name) as string[])
  const head = ['frequency(fps)', 'RobotType', 'DOF Number', 'time(ms)', 'position X(m)', 'position Y(m)', 'position Z(m)',
    'quaternion X', 'quaternion Y', 'quaternion Z', 'quaternion W', ...joints].join(',') + ','
  const csv = Buffer.from([head, ...Array.from({ length: 120 }, (_, i) =>
    [50, 0, 29, Math.round(i * 1000 / 50), (0.01 * i).toFixed(6), '0.000000', '0.790000', '0', '0', '0', '1',
      ...joints.map((_, j) => (0.02 * Math.sin(i / 9 + j)).toFixed(6))].join(',') + ',')].join('\n') + '\n')
  await page.getByRole('button', { name: '파일', exact: true }).click()
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'CSV 가져오기', exact: true }).click()])
  await fc.setFiles([{ name: 'a.csv', mimeType: 'text/csv', buffer: csv }])
  await expect.poll(() => items(page)).toBe(1)

  const seq = page.locator('.seq-canvas')
  await page.evaluate(() => (window as any).__editor.getState().setFrame(40))
  await seq.focus(); await page.keyboard.press('c')
  expect(await items(page)).toBe(2)

  const box = (await seq.boundingBox())!
  await page.mouse.click(box.x + 8, box.y + 24 + 14) // ▸ of the G1 row
  await expect(page.getByRole('button', { name: /클립 목록$/ })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('button', { name: /클립 프리뷰$/ })).toHaveCount(2)
  await page.mouse.click(box.x + 60, box.y + 24 + 28 + 22 + 11) // second child row
  const pane = page.getByRole('region', { name: '클립 프리뷰' })
  await expect(pane).toContainText('클립 프리뷰 · G1 #1 / a')
  await expect.poll(() => pane.locator('canvas').evaluate(c => c.getBoundingClientRect().width)).toBeGreaterThan(0)

  await pane.getByRole('button', { name: '기본자세 세팅' }).click()
  await expect(pane.getByRole('status')).toHaveText('시작 자세를 기본자세로 맞췄습니다')
  expect(await items(page)).toBe(2) // no clip/item added
  const start = await page.evaluate(() => { // second item's first frame (clip frame 40): every joint key is 0
    const p = (window as any).__editor.getState().project, c = p.clips[Object.keys(p.clips)[0]]
    return Object.entries(c.channels).filter(([n]) => !n.startsWith('root.')).map(([, cv]: any) => cv.keys.find((k: any) => k.f === 40)?.v)
  })
  expect(start.length).toBeGreaterThan(0)
  for (const v of start) expect(Math.abs(v)).toBeLessThan(1e-9)
  await pane.getByRole('button', { name: '클립 프리뷰 닫기' }).click()
  await expect(pane).toHaveCount(0)
  expect(errors).toEqual([])
})
