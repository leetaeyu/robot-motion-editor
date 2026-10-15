import { create } from 'zustand'
import { csvToClip, isHeadedCsv } from './export/importCsv'
import { objectUrl, openMediaFiles, openTextFiles, revokeUrl } from './fileio'
import { probeDuration, setMediaUrl } from './media/registry'
import { videoEnd } from './model/video'
import { getEditor, projectGeneration } from './store/store'
import { FPS } from './model/fps'

type Result = { head?: string; lines: string[] }
type Fps = 30 | 50 | 60

/** Import UI state: the pending fps question (answered by CsvFpsDialog) and the last result shown in the asset panel. */
export const useImportUi = create<{ ask: ((v: Fps | null) => void) | null; res: Result | null }>(() => ({ ask: null, res: null }))
export const setImportResult = (res: Result | null) => useImportUi.setState({ res })
const askFps = () => new Promise<Fps | null>(resolve => useImportUi.setState({ ask: resolve }))
const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function importCsvFiles() {
  setImportResult(null)
  const files = await openTextFiles('.csv,.json', true)
  if (!files.length) return
  let fps: Fps = FPS // unused when every file is headed
  if (files.some(f => !isHeadedCsv(f.text))) {
    const v = await askFps()
    if (!v) return
    fps = v
  }
  const ed = getEditor()
  let n = 0
  const fails: string[] = []
  ed.getState().beginGesture() // one undo entry for the whole batch
  for (const f of files) {
    try {
      const clip = csvToClip(f.text, ed.getState().defs, fps, f.name.replace(/\.(csv|json)$/i, ''))
      ed.getState().importClipToActor(clip)
      n++
    } catch (e) { fails.push(`${f.name}: ${why(e)}`) }
  }
  ed.getState().endGesture()
  setImportResult({ head: `클립 ${n}개를 가져왔습니다`, lines: fails })
}

async function probe(f: File) {
  const url = objectUrl(f)
  try { return { url, durationF: await probeDuration(url) } } catch (e) { revokeUrl(url); throw e }
}

export async function importVideoFiles() {
  setImportResult(null)
  const files = await openMediaFiles(true)
  if (!files.length) return
  const ed = getEditor()
  const gen = projectGeneration()
  const lines: string[] = []
  const ok: { name: string; url: string; durationF: number }[] = []
  for (const f of files) { // probe everything first so the gesture below has no awaits
    try { ok.push({ name: f.name.replace(/\.[^.]*$/, ''), ...(await probe(f)) }) }
    catch (e) { lines.push(`${f.name}: ${why(e)}`) }
  }
  if (gen !== projectGeneration()) { ok.forEach(o => revokeUrl(o.url)); return } // another project was opened meanwhile
  const s = ed.getState()
  s.beginGesture() // one undo entry for the whole batch
  let placed = 0
  try {
    for (const o of ok) {
      const id = s.addMedia(o.name, o.durationF)
      setMediaUrl(id, o.url)
      // place it on V1 right away so the preview shows without a manual drag
      if (s.addVideoItem(id, videoEnd(ed.getState().project))) placed++
      else lines.push(`${o.name}: 잠긴 트랙입니다`)
    }
  } finally { s.endGesture() }
  if (placed) s.setVideoMode('split')
  setImportResult({ head: `영상 ${ok.length}개를 가져왔습니다`, lines })
}

export async function relinkMedia(m: { id: string; durationF: number }) {
  const ed = getEditor()
  setImportResult(null)
  const gen = projectGeneration()
  const [f] = await openMediaFiles(false)
  if (!f) return
  try {
    const { url, durationF } = await probe(f)
    if (gen !== projectGeneration() || !ed.getState().project.media.some(x => x.id === m.id)) { revokeUrl(url); return } // project changed or media deleted meanwhile
    setMediaUrl(m.id, url)
    if (Math.abs(durationF - m.durationF) > 1)
      setImportResult({ lines: [`길이가 다른 영상입니다(${(durationF / FPS).toFixed(2)}초 ≠ ${(m.durationF / FPS).toFixed(2)}초)`] })
  } catch (e) { setImportResult({ lines: [`${f.name}: ${why(e)}`] }) }
}
