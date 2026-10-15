import fs from 'node:fs'
import { test, expect, type Download, type Page } from '@playwright/test'

const menu = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '파일', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}


const row = Array.from({ length: 36 }, (_, i) => (i === 6 ? 1 : 0)).join(',')
const csv = Buffer.from([row, row, row].join('\n') + '\n')

test('headerless CSV import: fps choice applies each time, bad file reported, one undo per batch', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker })
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const clips = () => page.evaluate(() => Object.values((window as any).__editor.getState().project.clips) as { name: string; length: number }[])
  expect(await page.evaluate(() => (window as any).__editor.getState().project.actors.length)).toBe(0) // starts empty
  const before = (await clips()).length
  const run = async (files: { name: string; mimeType: string; buffer: Buffer }[], fps: '30fps' | '50fps') => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'CSV 가져오기')])
    await fc.setFiles(files)
    await page.getByLabel(fps).check()
    await page.getByRole('button', { name: '가져오기', exact: true }).click()
  }
  await run([{ name: 'a.csv', mimeType: 'text/csv', buffer: csv }], '30fps')
  await run([{ name: 'b.csv', mimeType: 'text/csv', buffer: csv }, { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('1,2,3\n') }], '50fps')
  await expect(page.locator('.pp-msg')).toContainText('bad.csv: 열 수가')
  const cs = await clips()
  expect(cs.find(c => c.name === 'a')!.length).toBe(4)
  expect(cs.find(c => c.name === 'b')!.length).toBe(3)
  expect(cs.length).toBe(before + 2)
  await run([{ name: 'a.csv', mimeType: 'text/csv', buffer: csv }], '30fps')
  expect((await clips()).some(c => c.name === 'a_2')).toBe(true)
  await page.evaluate(() => (window as any).__editor.getState().undo())
  expect((await clips()).length).toBe(before + 2)
})

test('headed CSV import creates the G1 actor; export reproduces the input', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).showOpenFilePicker; delete (window as any).showDirectoryPicker })
  const downloads: Download[] = []
  page.on('download', d => downloads.push(d))
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const joints = await page.evaluate(() => (window as any).__editor.getState().defs.g1.joints.map((j: { name: string }) => j.name) as string[])
  const head = ['frequency(fps)', 'RobotType', 'DOF Number', 'time(ms)', 'position X(m)', 'position Y(m)', 'position Z(m)',
    'quaternion X', 'quaternion Y', 'quaternion Z', 'quaternion W', ...joints].join(',') + ','
  const N = 60
  const data = Array.from({ length: N }, (_, i) => {
    const yaw = 0.02 * i, qz = Math.sin(yaw / 2), qw = Math.cos(yaw / 2)
    return [50, 0, 29, Math.round(i * 1000 / 50), (0.01 * i).toFixed(6), (0.2 * Math.sin(i / 9)).toFixed(6), '0.790000',
      '0.000000', '0.000000', qz.toFixed(6), qw.toFixed(6), ...joints.map((_, j) => (0.02 * Math.sin(i / 9 + j)).toFixed(6))].join(',') + ','
  })
  const input = [head, ...data].join('\n') + '\n'

  const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'CSV 가져오기')])
  await fc.setFiles([{ name: 'gen.csv', mimeType: 'text/csv', buffer: Buffer.from(input) }])
  // headed: no fps dialog, imported straight away
  await expect(page.locator('.pp-msg')).toContainText('클립 1개를 가져왔습니다')
  await expect(page.locator('dialog.pp-dlg[open]')).toHaveCount(0)
  await expect(page.locator('.pp-tag')).toHaveText('G1')

  const placed = await page.evaluate(() => {
    const p = (window as any).__editor.getState().project
    return { actors: p.actors.map((a: any) => a.robot), items: p.sequence.tracks.map((t: any) => ({ actor: t.actorId === p.actors[0].id, items: t.items.map((i: any) => [p.clips[i.refId].name, i.start, i.trimOut - i.trimIn]) })) }
  })
  expect(placed).toEqual({ actors: ['g1'], items: [{ actor: true, items: [['gen', 0, N]] }] })

  await menu(page, '내보내기')
  await page.getByRole('radio', { name: '월드' }).check()
  await page.getByRole('button', { name: /CSV 내보내기|무시하고 내보내기/ }).click()
  await expect.poll(() => downloads.length).toBe(1)
  const out = fs.readFileSync((await downloads[0].path())!, 'utf8').trimEnd().split('\n')
  const inp = input.trimEnd().split('\n')
  expect(out[0]).toBe(inp[0])
  expect(out).toHaveLength(N + 1)
  for (let r = 1; r <= N; r++) {
    const a = inp[r].split(','), b = out[r].split(',')
    expect(b).toHaveLength(a.length)
    expect(b.slice(0, 4)).toEqual(a.slice(0, 4)) // fps, type, DOF and time(ms) exact
    const q = a.slice(7, 11).map(Number), o = b.slice(7, 11).map(Number)
    const sign = q.reduce((s, v, i) => s + v * o[i], 0) < 0 ? -1 : 1 // quaternion sign may flip
    a.slice(4, a.length - 1).forEach((v, c) => {
      const want = c >= 3 && c < 7 ? sign * Number(b[c + 4]) : Number(b[c + 4])
      expect(Math.abs(Number(v) - want)).toBeLessThan(1e-5)
    })
  }
  expect(errors).toEqual([])
})

test('파일 menu: keyboard navigation and focus return', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const trigger = page.getByRole('button', { name: '파일', exact: true })
  const items = page.getByRole('menuitem')
  const focused = () => page.evaluate(() => document.activeElement?.textContent?.replace(/Ctrl.*/, ''))
  const playing = () => page.evaluate(() => (window as any).__editor.getState().playing)
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(items).toHaveCount(8)
  expect(await focused()).toBe('새 프로젝트')
  await page.keyboard.press('ArrowUp') // wraps to the last
  expect(await focused()).toBe('내보내기')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  expect(await focused()).toBe('열기')
  await page.keyboard.press('End')
  expect(await focused()).toBe('내보내기')
  await page.keyboard.press('Space') // activates the item, not a global play toggle
  await expect(page.locator('dialog.exp[open]')).toHaveCount(1)
  expect(await playing()).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog.exp[open]')).toHaveCount(0)
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(items).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(items).toHaveCount(0)
  await trigger.click()
  await page.locator('#inspector').click({ position: { x: 5, y: 200 } })
  await expect(items).toHaveCount(0)
})
