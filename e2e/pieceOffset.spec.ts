import { test, expect } from '@playwright/test'

// 조각 수정 층: the inspector edits the piece's offset by default (no 자동 키), the shared clip stays as it was.
test('이 조각 수정: slider works without 자동 키, clip untouched; 원본 클립 수정 needs 자동 키; 수정 지우기 restores', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 30000 })
  const ch = 'FL_thigh_joint'
  await page.evaluate(ch => {
    const s = (window as any).__editor.getState()
    s.addActor('go2')
    const a = (window as any).__editor.getState().project.actors.at(-1)
    s.select(a.id, ch); s.setFrame(30)
  }, ch)
  const state = () => page.evaluate(ch => {
    const p = (window as any).__editor.getState().project, it = p.sequence.tracks.find((t: any) => t.kind === 'motion').items[0]
    return { clipKeys: p.clips[it.refId].channels[ch]?.keys.length ?? 0, offset: it.offset?.[ch]?.keys.map((k: any) => [k.f, +k.v.toFixed(4)]) ?? null }
  }, ch)

  await expect(page.getByRole('button', { name: '이 조각 수정' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('slider', { name: ch })).toBeEnabled()
  const num = page.getByLabel(`${ch} 값`)
  await num.fill('40'); await num.press('Enter')
  await expect.poll(state).toEqual({ clipKeys: 0, offset: [[30, +(40 * Math.PI / 180 - 0).toFixed(4)]] })
  await expect(page.getByText('이 조각의 수정 키 1개')).toBeVisible()

  await page.getByRole('button', { name: '원본 클립 수정' }).click()
  await expect(page.getByRole('slider', { name: ch })).toBeDisabled()
  await expect(page.getByText('자동 키를 켜면 원본 클립을 고칠 수 있습니다')).toBeVisible()

  await page.getByRole('button', { name: '이 조각 수정' }).click()
  await page.getByRole('button', { name: '수정 지우기' }).click()
  await expect.poll(state).toEqual({ clipKeys: 0, offset: null })
})
