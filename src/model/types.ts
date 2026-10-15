import type { RobotKind } from '../robot/types';

export type Interp = 'linear' | 'bezier' | 'hold';
export interface Tan { df: number; dv: number }
export interface Key { f: number; v: number; interp: Interp; inTan: Tan; outTan: Tan }
export interface Curve { keys: Key[] }
export interface Clip { id: string; name: string; robot: RobotKind; length: number; channels: Record<string, Curve> }
export interface Actor { id: string; name: string; robot: RobotKind; color: string; placement: { x: number; y: number; yaw: number } }
export interface Item { id: string; refId: string; start: number; trimIn: number; trimOut: number; offset?: Record<string, Curve> /* 조각 수정 층: delta curves in clip frames, added to the clip for this piece only (model/itemClip.ts) */ }
export interface Track { id: string; kind: 'video' | 'motion'; actorId?: string; hidden: boolean; locked: boolean; items: Item[] }
export interface Media { id: string; name: string; durationF: number }
export interface Sequence { tracks: Track[]; markers: { f: number; name: string }[]; inF: number | null; outF: number | null }
export interface Project { version: 1 | 2; fps: 50; actors: Actor[]; clips: Record<string, Clip>; media: Media[]; sequence: Sequence }
