import fs from 'node:fs'
import { test, expect, type Download, type Page } from '@playwright/test'

const menu = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '파일', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}


test.describe.configure({ mode: 'serial' })

const init = () => {
  const w = window as any
  delete w.showDirectoryPicker; delete w.showOpenFilePicker; delete w.showSaveFilePicker
}

test('import CSV, place two items with crossfade, export all', async ({ page }) => {
  await page.addInitScript(init)
  const downloads: Download[] = []
  page.on('download', d => downloads.push(d))
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  await page.evaluate(() => (window as any).__editor.getState().addActor('go2')) // the app starts empty; the CSV import creates the G1

  const rows = Array.from({ length: 60 }, () => Array.from({ length: 36 }, (_, i) => (i === 0 ? 5 : i === 1 ? 7 : i === 6 ? 1 : 0)).join(','))
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu(page, 'CSV 가져오기')])
  await fc.setFiles([{ name: 'walk_g1.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n') + '\n') }])
  await page.getByLabel('50fps').check()
  await page.getByRole('button', { name: '가져오기', exact: true }).click()
  await expect(page.locator('.pp-name', { hasText: 'walk_g1' })).toBeVisible()

  const placed = await page.evaluate(() => {
    const s = (window as any).__editor.getState()
    const actor = s.project.actors.find((a: any) => a.robot === 'g1').id
    const clip = Object.values(s.project.clips).find((c: any) => c.name === 'walk_g1') as any
    return { ok: (window as any).__editor.getState().addItem(actor, clip.id, 100), len: clip.length }
  })
  expect(placed).toEqual({ ok: true, len: 60 })

  await menu(page, '내보내기')
  await page.getByRole('button', { name: /CSV 내보내기|무시하고 내보내기/ }).click()
  await expect.poll(() => downloads.length).toBe(3)
  const files = await Promise.all(downloads.map(async d => ({ name: d.suggestedFilename(), text: fs.readFileSync((await d.path())!, 'utf8') })))
  const lines = (t: string) => t.trim().split('\n')
  const imp = files.find(f => f.name === 'G1_walk_g1.csv')!
  expect(imp).toBeTruthy()
  expect(lines(imp.text)).toHaveLength(61)
  expect(lines(imp.text)[0].split(',')).toHaveLength(41)
  const [x, y] = lines(imp.text)[1].split(',').slice(4, 6)
  expect([Number(x), Number(y)]).toEqual([0, 0])
  expect(files.some(f => f.name.startsWith('GO2_') && lines(f.text)[1].split(',').length === 24)).toBe(true)
})

test('save and reopen restores sequence', async ({ page }) => {
  await page.addInitScript(init)
  page.on('dialog', d => d.accept())
  const downloads: Download[] = []
  page.on('download', d => downloads.push(d))
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })

  await page.evaluate(() => {
    ;(window as any).__editor.getState().addActor('g1')
    const s = (window as any).__editor.getState()
    const item = s.project.sequence.tracks.find((t: any) => t.kind === 'motion').items[0]
    s.setKey(item.refId, Object.keys(s.project.clips[item.refId].channels)[0] ?? 'root.x', 10, 0.25)
    ;(window as any).__editor.getState().moveItem(item.id, 30)
  })
  const snap = () => page.evaluate(() => {
    const p = (window as any).__editor.getState().project
    return JSON.stringify({ actors: p.actors, clips: p.clips, sequence: p.sequence })
  })
  const before = await snap()
  expect(JSON.parse(before).sequence.tracks.find((t: any) => t.kind === 'motion').items[0].start).toBe(30)

  await menu(page, '저장')
  await expect.poll(() => downloads.length).toBe(1)
  const saved = fs.readFileSync((await downloads[0].path())!)
  const name = downloads[0].suggestedFilename()

  await menu(page, '새 프로젝트')
  expect(await snap()).not.toBe(before)
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu(page, '열기')])
  await fc.setFiles([{ name, mimeType: 'application/json', buffer: saved }])
  await expect.poll(snap).toBe(before)
  expect(await page.evaluate(() => (window as any).__editor.getState().dirty)).toBe(false)
})
