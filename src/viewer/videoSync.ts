import { FPS } from '../model/fps'
export type SyncAction = { kind: 'seek'; t: number; play: boolean } | { kind: 'none'; play: boolean }

// Pure: what to do with the <video> so it matches the playhead's media time.
export function syncAction(target: { seconds: number }, video: { currentTime: number; paused: boolean }, playing: boolean): SyncAction {
  const tol = playing ? 2 / FPS : 0.5 / FPS
  return Math.abs(video.currentTime - target.seconds) > tol
    ? { kind: 'seek', t: target.seconds, play: playing }
    : { kind: 'none', play: playing }
}
