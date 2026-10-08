// GO2 block templates: real-robot logs (headed Unitree CSV, 50fps) in public/go2-blocks/{id}.csv.

export type Range = [number, number] // [start, end) source 50fps frames
export interface LoopSpec { head: Range; loop: Range; tail: Range }
export type Block =
  | { id: string; label: string; kind: 'fixed' }
  | { id: 'move'; label: 'Move forward'; kind: 'loop'; param: 'meters'; spec: LoopSpec }
  | { id: 'rotate'; label: 'Rotate'; kind: 'loop'; param: 'degrees'; left: LoopSpec; right: LoopSpec }

export const GO2_BLOCKS: Block[] = [
  // stand still -> accelerate; loop = 1 gait cycle (35f, 0.62m, joint RMS 0.009 rad); tail decelerates to the speed minimum
  { id: 'move', label: 'Move forward', kind: 'loop', param: 'meters', spec: { head: [30, 117], loop: [117, 153], tail: [153, 171] } },
  // the spin log turns right from rest (60), reverses left at ~150, reverses again at ~245; loops = 36f, ±72°, RMS 0.013 / 0.02
  { id: 'rotate', label: 'Rotate', kind: 'loop', param: 'degrees',
    left: { head: [150, 202], loop: [202, 238], tail: [238, 245] },
    right: { head: [40, 107], loop: [107, 143], tail: [143, 150] } },
  { id: 'stretch', label: 'Stretch', kind: 'fixed' },
  { id: 'heart', label: 'ShowHeart', kind: 'fixed' },
  { id: 'hello', label: 'Hello', kind: 'fixed' },
  { id: 'sit', label: 'Sit', kind: 'fixed' },
  { id: 'standup', label: 'StandUp', kind: 'fixed' },
  { id: 'standdown', label: 'StandDown', kind: 'fixed' },
  { id: 'scrape', label: 'Scrape', kind: 'fixed' },
  { id: 'frontjump', label: 'FrontJump', kind: 'fixed' },
  { id: 'frontpounce', label: 'FrontPounce', kind: 'fixed' },
  { id: 'frontflip', label: 'FrontFlip', kind: 'fixed' },
  { id: 'backflip', label: 'BackFlip', kind: 'fixed' },
  { id: 'leftflip', label: 'LeftFlip', kind: 'fixed' },
  { id: 'rightflip', label: 'RightFlip', kind: 'fixed' },
]

export const blockUrl = (id: string) => `/go2-blocks/${id}.csv`
