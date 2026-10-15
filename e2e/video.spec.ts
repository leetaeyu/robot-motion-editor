import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect, type Download, type Page } from '@playwright/test'

const menu = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '파일', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}


test.describe.configure({ mode: 'serial' })

const dir = path.resolve('test-results')
const file = path.join(dir, 'ref-test.mp4')

test.beforeAll(() => {
  fs.mkdirSync(dir, { recursive: true })
  try {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '2', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') test.skip(true, 'ffmpeg 없음')
    else throw e
  }
})

const init = () => {
  const w = window as any
  delete w.showDirectoryPicker; delete w.showOpenFilePicker; delete w.showSaveFilePicker
}

const open = async (page: Page) => {
  await page.addInitScript(init)
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
}

const importVideo = async (page: Page) => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu(page, '영상 가져오기')])
  await fc.setFiles(file)
  await expect(page.locator('.pp-media')).toHaveCount(1)
}

test('import video auto-places on V1 in split view, scrub syncs', async ({ page }) => {
  await open(page)
  await importVideo(page)
  // import alone places the video at frame 0 and switches the preview to split
  const auto = await page.evaluate(() => {
    const s = (window as any).__editor.getState()
    const v1 = s.project.sequence.tracks.find((t: any) => t.kind === 'video')
    return { items: v1.items.map((i: any) => i.start), mode: s.videoMode }
  })
  expect(auto).toEqual({ items: [0], mode: 'split' })
  await page.evaluate(() => {
    const e = (window as any).__editor, s = e.getState()
    const v1 = s.project.sequence.tracks.find((t: any) => t.kind === 'video')
    s.moveItem(v1.items[0].id, 60)
    e.getState().setFrame(85)
  })
  const video = page.locator('#stage video')
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => Math.abs(v.currentTime - 0.5) <= 1 / 50), { timeout: 5000 }).toBe(true)
  await page.evaluate(() => (window as any).__editor.getState().setFrame(30))
  // split keeps the slot but hides the picture outside the item
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => getComputedStyle(v).visibility)).toBe('hidden')
})

test('save/reopen marks media offline, relink restores', async ({ page }) => {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error' && !m.location().url.includes('favicon')) errors.push(m.text()) })
  page.on('dialog', d => d.accept())
  const downloads: Download[] = []
  page.on('download', d => downloads.push(d))
  await open(page)
  await importVideo(page)

  await menu(page, '저장')
  await expect.poll(() => downloads.length).toBe(1)
  const saved = fs.readFileSync((await downloads[0].path())!)
  const name = downloads[0].suggestedFilename()

  await menu(page, '새 프로젝트')
  await expect(page.locator('.pp-media')).toHaveCount(0)
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), menu(page, '열기')])
  await fc.setFiles([{ name, mimeType: 'application/json', buffer: saved }])
  await expect(page.getByText('오프라인').first()).toBeVisible()

  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /다시 연결/ }).click()])
  await fc2.setFiles(file)
  await expect(page.getByText('오프라인')).toHaveCount(0)
  expect(errors).toEqual([])
})
