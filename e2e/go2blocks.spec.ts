import { test, expect, type Page } from '@playwright/test'

const start = async (page: Page, robot: 'g1' | 'go2') => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  return page.evaluate(r => {
    const ed = (window as any).__editor
    ed.getState().addActor(r) // the app starts empty
    const a = ed.getState().project.actors.at(-1)
    ed.getState().select(a.id)
    return a.id as string
  }, robot)
}
const trackItems = (page: Page, actorId: string) => page.evaluate(id => {
  const p = (window as any).__editor.getState().project
  return p.sequence.tracks.find((t: any) => t.actorId === id).items
    .map((i: any) => ({ start: i.start, len: i.trimOut - i.trimIn, name: p.clips[i.refId].name }))
    .sort((a: any, b: any) => a.start - b.start)
}, actorId)
const clipCount = (page: Page) => page.evaluate(() => Object.keys((window as any).__editor.getState().project.clips).length)

test('GO2 selected → block panel adds Move then Stretch at the track end', async ({ page }) => {
  const id = await start(page, 'go2')
  const before = await trackItems(page, id)
  const end0 = Math.max(0, ...before.map(i => i.start + i.len))

  await expect(page.getByLabel('블럭')).toBeVisible()
  await page.getByLabel('블럭').selectOption({ label: 'Move forward' })
  await page.getByLabel('값').fill('1.8')
  await expect(page.getByText(/실제 .*m \(\d+회\)/)).toBeVisible()
  await page.getByRole('button', { name: '추가', exact: true }).click()
  await expect.poll(async () => (await trackItems(page, id)).length).toBe(before.length + 1)
  const move = (await trackItems(page, id)).at(-1)!
  expect(move.start).toBe(end0)
  expect(move.name).toMatch(/^Move_/)

  await page.getByLabel('블럭').selectOption({ label: 'Stretch' })
  await expect(page.getByLabel('값')).toHaveCount(0)
  await page.getByRole('button', { name: '추가', exact: true }).click()
  await expect.poll(async () => (await trackItems(page, id)).length).toBe(before.length + 2)
  const stretch = (await trackItems(page, id)).at(-1)!
  expect(stretch).toMatchObject({ start: move.start + move.len, name: 'Stretch' })
})

test('G1 selected → no block panel', async ({ page }) => {
  await start(page, 'g1')
  await expect(page.locator('#inspector')).toContainText('G1')
  await expect(page.getByLabel('블럭')).toHaveCount(0)
})

test('empty value disables 추가', async ({ page }) => {
  await start(page, 'go2')
  await page.getByLabel('블럭').selectOption({ label: 'Rotate' })
  await expect(page.getByRole('button', { name: '추가', exact: true })).toBeEnabled()
  await page.getByLabel('값').fill('')
  await expect(page.getByRole('button', { name: '추가', exact: true })).toBeDisabled()
})

test('template 404 shows error, project unchanged', async ({ page }) => {
  await page.route('**/go2-blocks/stretch.csv', r => r.fulfill({ status: 404, body: '' }))
  await start(page, 'go2')
  const n = await clipCount(page)
  await page.getByLabel('블럭').selectOption({ label: 'Stretch' })
  await expect(page.getByRole('alert')).toContainText('템플릿을 불러오지 못했습니다')
  await expect(page.getByRole('button', { name: '추가', exact: true })).toBeDisabled()
  expect(await clipCount(page)).toBe(n)
})

test('파일 ▸ GO2 블럭 추가… works without a GO2: first add makes one at 0 s, the next appends to it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  expect(await page.evaluate(() => (window as any).__editor.getState().project.actors.length)).toBe(0)
  await page.getByRole('button', { name: '파일', exact: true }).click()
  await page.getByRole('menuitem', { name: 'GO2 블럭 추가…' }).click()
  const dlg = page.locator('dialog.go2-dlg')
  await expect(dlg.getByLabel('붙일 로봇')).toHaveValue('new')
  await dlg.getByLabel('블럭').selectOption({ label: 'Stretch' })
  await dlg.getByRole('button', { name: '추가', exact: true }).click()
  await expect(dlg).toContainText('추가했습니다: Stretch')
  const actors = () => page.evaluate(() => (window as any).__editor.getState().project.actors.map((a: any) => a.robot))
  expect(await actors()).toEqual(['go2'])
  const id = await page.evaluate(() => (window as any).__editor.getState().project.actors[0].id)
  await expect(dlg.getByLabel('붙일 로봇')).toHaveValue(id) // now appends to the new GO2
  await dlg.getByLabel('블럭').selectOption({ label: 'Sit' })
  await dlg.getByRole('button', { name: '추가', exact: true }).click()
  await expect.poll(async () => (await trackItems(page, id)).map(i => i.name)).toEqual(['Stretch', 'Sit'])
  const [a, b] = await trackItems(page, id)
  expect(a.start).toBe(0)
  expect(b.start).toBe(a.len)
  expect(await actors()).toEqual(['go2'])
  await dlg.getByRole('button', { name: '닫기' }).click()
  await expect(dlg).toBeHidden()
})
