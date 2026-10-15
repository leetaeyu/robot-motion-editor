import { test, expect, type Page } from '@playwright/test'

const tracks = (page: Page) => page.evaluate(() =>
  (window as any).__editor.getState().project.sequence.tracks.filter((t: any) => t.kind === 'motion')
    .map((t: any) => t.items.map((i: any) => [i.start, i.trimOut - i.trimIn]))) as Promise<number[][][]>

test('drop: card onto a track appends after the overlapped item; empty area makes a new actor', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showDirectoryPicker })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const joints = await page.evaluate(() => (window as any).__editor.getState().defs.g1.joints.map((j: { name: string }) => j.name) as string[])
  const head = ['frequency(fps)', 'RobotType', 'DOF Number', 'time(ms)', 'position X(m)', 'position Y(m)', 'position Z(m)',
    'quaternion X', 'quaternion Y', 'quaternion Z', 'quaternion W', ...joints].join(',') + ','
  const csv = (n: number) => Buffer.from([head, ...Array.from({ length: n }, (_, i) =>
    [50, 0, 29, Math.round(i * 1000 / 50), (0.01 * i).toFixed(6), '0.000000', '0.790000', '0', '0', '0', '1',
      ...joints.map((_, j) => (0.02 * Math.sin(i / 9 + j)).toFixed(6))].join(',') + ',')].join('\n') + '\n')
  for (const [name, n] of [['a', 120], ['b', 60]] as const) {
    await page.getByRole('button', { name: '파일', exact: true }).click()
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'CSV 가져오기', exact: true }).click()])
    await fc.setFiles([{ name: `${name}.csv`, mimeType: 'text/csv', buffer: csv(n) }])
    await expect(page.getByText('클립 1개를 가져왔습니다')).toBeVisible()
  }
  expect(await tracks(page)).toEqual([[[0, 120]]]) // second CSV went to the assets only

  const seq = page.locator('.seq-canvas')
  const card = page.locator('.pp-card', { hasText: 'b' }).first()
  const box = (await seq.boundingBox())!
  await card.dragTo(seq, { targetPosition: { x: 250, y: 24 + 14 } }) // over item a, never overlapping it
  expect(await tracks(page)).toEqual([[[0, 120], [120, 60]]])

  await card.dragTo(seq, { targetPosition: { x: 500, y: box.height - 20 } }) // empty area below the tracks
  expect(await tracks(page)).toEqual([[[0, 120], [120, 60]], [[expect.any(Number), 60]]])
  expect(errors).toEqual([])
})
