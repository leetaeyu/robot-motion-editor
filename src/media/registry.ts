// Runtime-only video object URLs. Never saved to the project.
import { revokeUrl } from '../fileio'
import { FPS } from '../model/fps'

const urls = new Map<string, string>()
const subs = new Set<() => void>()
const notify = () => subs.forEach(f => f())

export function setMediaUrl(mediaId: string, url: string) {
  const old = urls.get(mediaId)
  if (old && old !== url) revokeUrl(old)
  urls.set(mediaId, url)
  notify()
}
export const mediaUrl = (mediaId: string) => urls.get(mediaId) ?? null
export function clearMedia() {
  urls.forEach(revokeUrl)
  urls.clear()
  notify()
}
export function subscribeMedia(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } }

const UNREADABLE = '영상을 읽을 수 없습니다'
export function probeDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'; v.muted = true
    const timer = setTimeout(() => done(new Error(UNREADABLE)), 10000)
    const done = (err: Error | null, d = 0) => {
      clearTimeout(timer)
      v.removeAttribute('src'); v.load()
      err ? reject(err) : resolve(Math.max(1, Math.round(d * FPS)))
    }
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? null : new Error(UNREADABLE), v.duration)
    v.onerror = () => done(new Error(UNREADABLE))
    v.src = url
  })
}
