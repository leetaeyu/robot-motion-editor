# GO2 블럭 편집 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GO2 액터 선택 시 인스펙터 상단 블럭 패널에서 블럭(Move/Rotate/Stretch…)을 골라 관절 키프레임 클립으로 변환해 트랙 끝에 추가한다.

**Architecture:** 실로봇 로그 CSV(50fps)를 `public/go2-blocks/`에 두고, CSV 파싱을 `Pose[]` 단계와 클립화 단계로 분리한다. 순수 함수 `buildBlockClip`이 고정형은 그대로, 루프형은 head + loop×N + tail로 포즈열을 만든 뒤 기존 클립화로 넘긴다. 스토어 `appendClip`이 클립 등록+트랙 끝 배치를 undo 1단계로 처리한다.

**Tech Stack:** Vite + React 19 + TypeScript, zustand, vitest(`npm test`), Playwright(`npm run e2e`). 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-10-08-go2-block-editor-design.md`

## Global Constraints

- 프로젝트 fps 60 고정. 블럭 템플릿 원본은 50fps 헤더형 Unitree CSV.
- 새 런타임 의존성 금지.
- UI 문구 한국어, 블럭 라벨은 스펙 표의 영문 라벨 그대로 (Move forward, Rotate, Stretch, ShowHeart, Hello, Sit, StandUp, StandDown, Scrape, FrontJump, FrontPounce, FrontFlip, BackFlip, LeftFlip, RightFlip).
- 블럭 클립 이름: `Move_{m}m`, `Rotate_{deg}deg` (deg는 부호 포함 정수, 실제값 기준), 고정형은 라벨. 중복 시 `_2`, `_3` … (기존 `importClipToActor` 규칙).
- Move 기본 1.0m, 최소 0.1. Rotate 기본 90°, 음수 = 우회전. N = max(1, round(|값| / 주기당 이동량)).
- 루프 이음새 블렌드 5프레임(원본 50fps 기준).
- G1 선택 시 인스펙터 화면 변화 없음.

## Review Focus

1. 작은 값(Move 0.1m, Rotate 10°) → N=1로 최소 1회 루프, 실제값 표시가 그 1회와 일치 — Task 3 테스트.
2. [추가] 연속 2회 → 두 번째 아이템이 첫 번째 끝에서 시작, 겹침 없음 — Task 4 테스트.
3. 트랙 아이템이 start 순으로 push되지 않았거나 트림된 경우 → 끝 = max(start + itemLen) — Task 4 테스트.
4. 숫자 입력 비움/NaN → [추가] 비활성, 편집 없음 — Task 5 e2e.
5. CSV fetch 실패(404) → 패널 안 오류 문구, 프로젝트 변경 없음 — Task 5 e2e.

---

### Task 1: CSV 파싱 분리 + 50fps 리샘플

**Files:**
- Modify: `src/export/importCsv.ts` (`parseHeaded` fps 검사, `csvToClip` 분해)
- Test: `src/export/importCsv.test.ts`

**Interfaces:**
- Produces:
  - `parseCsvPoses(text: string, defs: RobotDefs, srcFps: 30 | 60 | undefined): { robot: RobotKind; fps: number; poses: Pose[] }` — 원본 fps 그대로. 행 → `{ rootPos: r[0..3], rootQuat: r[3..7], q: r[7..] }`.
  - `posesToClip(poses: Pose[], fps: number, robot: RobotKind, defs: RobotDefs, name: string): Clip` — 60fps로 리샘플 후 기존과 같은 euler 변환·linear 키.
  - `csvToClip` 시그니처 유지 = `posesToClip(...parseCsvPoses(...))`.

- [ ] **Step 1: 실패 테스트 작성**

```ts
test('headed 50fps → resampled to 60fps', () => {
  // 헤더형 GO2, 50fps, 6행. root.x = 행번호 * 0.1 (프레임당 0.1m @50fps)
  const clip = csvToClip(headedGo2(50, 6, i => ({ x: i * 0.1 })), defs, undefined, 'r50')
  expect(clip.length).toBe(Math.floor(5 * 60 / 50) + 1)       // 7
  const x = clip.channels['root.x'].keys
  expect(x[0].v).toBeCloseTo(0); expect(x.at(-1)!.v).toBeCloseTo(0.5)
  expect(x[3].v).toBeCloseTo(3 * 50 / 60 * 0.1)                // t=2.5 → 0.25
})
test('headed 25fps still rejected', () => {
  expect(() => csvToClip(headedGo2(25, 4), defs, undefined, 'x')).toThrow('지원하지 않는 fps')
})
test('parseCsvPoses keeps source fps and frames', () => {
  const r = parseCsvPoses(headedGo2(50, 6), defs, undefined)
  expect(r).toMatchObject({ robot: 'go2', fps: 50 }); expect(r.poses).toHaveLength(6)
})
```

`headedGo2(fps, n, over?)`는 이 테스트 파일에 이미 있는 헤더형 헬퍼(`headed(...)`)를 fps 인자 받게 확장하거나 같은 방식으로 작성.

- [ ] **Step 2: 실패 확인** — `npx vitest run src/export/importCsv.test.ts` → 새 3개 FAIL (`지원하지 않는 fps입니다: 50`, `parseCsvPoses` 없음).

- [ ] **Step 3: 구현**
  - `parseHeaded` 허용 fps: `30 | 50 | 60`.
  - 리샘플(fps≠60): 60fps 프레임 f → t = f × fps/60, i = floor(t), w = t − i; 위치·관절 선형, 쿼터니언 `slerp`(`model/sequence`). 길이 = floor((n−1) × 60/fps) + 1. 기존 30fps 전용 분기는 이것으로 대체.

- [ ] **Step 4: 통과 확인** — `npx vitest run src/export/importCsv.test.ts` → 전체 PASS (기존 30fps·roundtrip 테스트 포함 = 회귀 없음).

- [ ] **Step 5: 커밋** — `feat(import): 헤더형 50fps CSV를 60fps로 리샘플; parseCsvPoses/posesToClip 분리`

---

### Task 2: 템플릿 CSV 복사 + 블럭 정의

**Files:**
- Create: `public/go2-blocks/{id}.csv` 15개 (스펙 §2 표대로 `assets/go2_from_log_cropped/` 에서 복사, 이름 = 블럭 id)
- Create: `src/go2blocks/blocks.ts`
- Test: `src/go2blocks/blocks.test.ts`

**Interfaces:**
- Consumes: `parseCsvPoses` (Task 1)
- Produces (`src/go2blocks/blocks.ts`):

```ts
export type Range = [number, number]            // [start, end) 원본 50fps 프레임
export interface LoopSpec { head: Range; loop: Range; tail: Range }
export type Block =
  | { id: string; label: string; kind: 'fixed' }
  | { id: 'move'; label: 'Move forward'; kind: 'loop'; param: 'meters'; spec: LoopSpec }
  | { id: 'rotate'; label: 'Rotate'; kind: 'loop'; param: 'degrees'; left: LoopSpec; right: LoopSpec }
export const GO2_BLOCKS: Block[]                // 스펙 §2 표 순서
export const blockUrl = (id: string) => `/go2-blocks/${id}.csv`   // fetchRobotDef와 같은 절대 경로 방식
```

- [ ] **Step 1: 루프 구간 결정 (분석, 코드 아님)**
  스크래치 스크립트로 `move.csv`, `rotate.csv`를 `parseCsvPoses`와 같은 방식으로 읽어 결정:
  - loop = 주기(Move 35f, Rotate ≈36f, 자기상관으로 재확인)의 정수배 길이 구간 중 **시작·끝 프레임 12관절 RMS 최소**. 후보 영역: Move 프레임 60~150, Rotate left(+yaw) 140~220 또는 430~684, right(−yaw) 250~360.
  - head = [loop 앞쪽에서 yaw속도/전진속도가 ≈0인 마지막 프레임, loop.start), tail = [loop.end, 이후 속도 ≈0이 되는 첫 프레임]. 정지 지점이 없으면 방향이 바뀌기 직전 프레임까지.
  - tail 길이 ≥ 5 (이음새 블렌드가 `loop.end + i` 를 참조).
  결정값과 근거(RMS, 주기당 이동량)를 `blocks.ts`의 `LoopSpec` 옆 한 줄 주석으로 남김.

- [ ] **Step 2: 실패 테스트 작성** (`blocks.test.ts`, `fs`로 `public/go2-blocks/*.csv` 읽기)

```ts
test('every block has a parsable GO2 csv', () => {
  for (const b of GO2_BLOCKS) expect(parseCsvPoses(read(b.id), defs, undefined)).toMatchObject({ robot: 'go2', fps: 50 })
})
test('loop specs are contiguous, in range, tail >= 5', () => {
  for (const s of loopSpecs()) {   // move.spec, rotate.left, rotate.right
    expect(s.head[1]).toBe(s.loop[0]); expect(s.loop[1]).toBe(s.tail[0])
    expect(s.tail[1] - s.tail[0]).toBeGreaterThanOrEqual(5)
    expect(s.tail[1]).toBeLessThanOrEqual(posesOf(s).length)
  }
})
test('per-loop motion: move 0.4~0.8m forward, rotate left > +40°, right < −40°', () => { /* loop 첫·끝 포즈 rebasePose 차이 */ })
```

- [ ] **Step 3: 실패 확인** — `npx vitest run src/go2blocks` → FAIL (모듈 없음).
- [ ] **Step 4: CSV 복사 + `blocks.ts` 작성** (Step 1 결정값 사용).
- [ ] **Step 5: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 6: 커밋** — `feat(go2blocks): 로그 템플릿 CSV 15개와 블럭 정의(루프 구간 포함)`

---

### Task 3: `buildBlockClip` / `blockActual`

**Files:**
- Create: `src/go2blocks/build.ts`
- Test: `src/go2blocks/build.test.ts`

**Interfaces:**
- Consumes: `Block`, `LoopSpec` (Task 2); `posesToClip` (Task 1); `applyXf`, `blendPose`, `Xf` (`model/sequence`); `rebasePose` (`model/pose`); `quatYaw` (`model/rootMath`)
- Produces:
  - `loopCount(spec: LoopSpec, poses: Pose[], block: Block, value: number): number` — 내부용 가능.
  - `blockActual(block: Block, poses: Pose[], value: number): { n: number; actual: number } | null` — 고정형 null. Move actual 단위 m, Rotate 단위 도(부호 포함).
  - `buildBlockClip(block: Block, poses: Pose[], fps: number, value: number, defs: RobotDefs): Clip` — robot `go2`, 60fps, 이름은 Global Constraints 규칙(중복 해소는 Task 4).

알고리즘 (루프형):
```
spec = move ? block.spec : value >= 0 ? block.left : block.right
a = poses[loop.start], b = poses[loop.end]
D: Xf  — applyXf(a, D)의 x·y·yaw가 b와 같아지는 평면 변환
        (yaw = quatYaw(b) − quatYaw(a); [x,y] = b.xy − R(yaw)·a.xy)
주기당 이동량: Move = |b.xy − a.xy| (m), Rotate = yaw (도)
N = max(1, round(|value| / |주기당 이동량|))
out = head 포즈
for k in 0..N-1: loop 포즈마다 applyXf를 k번 적용 (D^k)
   k ≥ 1 이면 copy의 처음 5프레임 i: blendPose(D^(k-1)·poses[loop.end + i], D^k·poses[loop.start + i], (i+1)/6)
tail 포즈마다 D^N 적용 (tail은 원본상 loop.end부터 이어지므로 경계 자연스러움)
out = out.map(p => rebasePose(p, out[0]))   // 첫 프레임 x·y·yaw = 0
return posesToClip(out, fps, 'go2', defs, name)
```
고정형: `posesToClip(poses.map(p => rebasePose(p, poses[0])), …)`.

- [ ] **Step 1: 실패 테스트 작성** — 합성 포즈(파일 없음): 전진 0.01m/f, yaw 0, 관절 `q[0] = sin(2πf/10)`, 50fps 60프레임. 블럭 = `{ id:'move', kind:'loop', param:'meters', spec:{ head:[0,10], loop:[10,30], tail:[30,40] } }` (주기당 0.2m).

```ts
test('move N from value: 1.0m → 5 loops, length', () => {
  const r = blockActual(move, poses, 1.0)!; expect(r).toEqual({ n: 5, actual: expect.closeTo(1.0, 5) })
  const clip = buildBlockClip(move, poses, 50, 1.0, defs)
  expect(clip.length).toBe(Math.floor((10 + 20 * 5 + 10 - 1) * 60 / 50) + 1)
})
test('move root advances head + N·loop + tail distance, starts at origin', () => { /* root.x 첫 키 0, 마지막 ≈ 0.01*(10+100+9) */ })
test('tiny value → n = 1', () => expect(blockActual(move, poses, 0.1)!.n).toBe(1))
test('rotate sign picks left/right spec; yaw delta sign matches', () => { /* 합성 회전 포즈: left 구간 +yaw, right 구간 −yaw */ })
test('fixed block: length = resampled source, rebased to origin', () => { /* 시작 x≠0 포즈 → root.x 첫 키 0 */ })
test('name: Move_1m, Rotate_-144deg, Stretch', () => { … })
test('real move.csv: 1.8m → actual within ±5% of n·perLoop and clip root.x end ≈ head+n·loop+tail', () => { /* public/go2-blocks/move.csv */ })
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/go2blocks/build.test.ts` → FAIL.
- [ ] **Step 3: 구현** (위 알고리즘).
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(go2blocks): buildBlockClip (head + loop×N + tail, 이음새 블렌드)`

---

### Task 4: 스토어 `appendClip`

**Files:**
- Modify: `src/store/store.ts` (액션 타입 + 구현, `importClipToActor` 근처)
- Test: `src/store/store.test.ts`

**Interfaces:**
- Produces: `appendClip(actorId: string, clip: Clip): string | null` — 성공 시 새 itemId. 한 번의 `tryEdit`:
  1. 액터 없음 / `clip.robot !== actor.robot` / 트랙 잠김 → false(null 반환).
  2. 이름 중복 해소 (`importClipToActor`와 같은 `_2`… 규칙; 중복 로직은 작은 헬퍼로 추출해 둘이 공유).
  3. `start = max(it.start + itemLen(it))` (아이템 없으면 0), `{ id, refId: clip.id, start, trimIn: 0, trimOut: clip.length }` push.
  4. `validTrack` 통과 시 true.

- [ ] **Step 1: 실패 테스트 작성**

```ts
test('appendClip places at track end (max start+len, not last pushed), one undo', () => {
  // 트랙 items: [{start:100, trimIn:10, trimOut:60}, {start:0, trimIn:0, trimOut:50}] → 끝 = 150
  const id = s().appendClip(go2Id, clip(30))!
  expect(item(id)).toMatchObject({ start: 150, trimIn: 0, trimOut: 30 })
  s().undo(); expect(s().project.clips[clipId]).toBeUndefined(); expect(item(id)).toBeUndefined()
})
test('appendClip twice → back to back', () => { /* 두 번째 start = 첫 번째 start + 30 */ })
test('appendClip on empty track starts at 0', …)
test('appendClip rejects locked track and robot mismatch', () => { /* null, project 불변 */ })
test('appendClip dedupes name', () => { /* 같은 이름 두 번 → 'Stretch', 'Stretch_2' */ })
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/store/store.test.ts` → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — `npx vitest run src/store` PASS.
- [ ] **Step 5: 커밋** — `feat(store): appendClip adds a clip at the end of an actor track in one undo step`

---

### Task 5: `Go2BlockPanel` + 인스펙터 연결 + e2e

**Files:**
- Create: `src/go2blocks/Go2BlockPanel.tsx`
- Modify: `src/inspector/Inspector.tsx` (기존 default 함수를 내부 `InspectorBody`로 이름 변경, 새 default가 패널 + 본문 렌더)
- Modify: `src/styles.css` (필요 시 `.go2-blocks` 몇 줄, 기존 `.insp-row` 재사용 우선)
- Test: `e2e/go2blocks.spec.ts`

**Interfaces:**
- Consumes: `GO2_BLOCKS`, `blockUrl` (Task 2); `parseCsvPoses` (Task 1); `blockActual`, `buildBlockClip` (Task 3); `appendClip`, `trackLocked` (Task 4 / store)
- Produces: `export default function Go2BlockPanel({ actorId }: { actorId: string })`

동작:
- `Inspector` default: 선택 액터가 `go2`면 `<Go2BlockPanel actorId>`를 `<InspectorBody/>` 위에. 클립 없는 GO2 액터에서도 패널 표시.
- 패널: `<select aria-label="블럭">`, 루프형이면 `<input type="number" aria-label="값">` (Move step 0.1·min 0.1·기본 1.0 / Rotate step 1·기본 90) + `<span role="status">` "→ 실제 1.8m (3회)" / "→ 실제 −144° (2회)", `<button>추가</button>`.
- 블럭 선택 시 CSV fetch → `parseCsvPoses` 결과를 모듈 레벨 `Map<id, Promise<…>>`로 캐시. 실제값 표시는 로드 후.
- [추가] 비활성: 로딩 중, 값 비어 있음/NaN, `trackLocked`.
- fetch/파싱 실패 → 패널 안 `<p className="insp-hint" role="alert">템플릿을 불러오지 못했습니다: {msg}</p>`, 편집 없음, 캐시에서 실패 항목 제거(재시도 가능).

- [ ] **Step 1: 실패 e2e 작성** (`e2e/sequence.spec.ts`의 `init`/`__editor` 패턴)

```ts
test('GO2 selected → block panel adds Move at track end', async ({ page }) => {
  // goto, canvas 대기, addActor('go2'), select(go2Id)
  await expect(page.getByLabel('블럭')).toBeVisible()
  await page.getByLabel('블럭').selectOption({ label: 'Move forward' })
  await page.getByLabel('값').fill('1.8')
  await expect(page.getByText(/실제 .*m \(\d+회\)/)).toBeVisible()
  await page.getByRole('button', { name: '추가', exact: true }).click()
  // __editor: go2 트랙 아이템 1개, start 0, clip.name ^Move_
  // 한 번 더 Stretch 추가 → 두 번째 start = 첫 번째 trimOut
})
test('G1 selected → no block panel', …)               // addActor('g1'), select → getByLabel('블럭') count 0
test('empty value disables 추가', …)                    // fill('') → toBeDisabled
test('template 404 shows error, project unchanged', async ({ page }) => {
  await page.route('**/go2-blocks/stretch.csv', r => r.fulfill({ status: 404, body: '' }))
  // Stretch 선택 → role=alert '템플릿을 불러오지 못했습니다', clips 수 불변
})
```

- [ ] **Step 2: 실패 확인** — `npx playwright test e2e/go2blocks.spec.ts` → FAIL (패널 없음).
- [ ] **Step 3: 구현** (위 동작).
- [ ] **Step 4: 통과 확인** — `npx playwright test e2e/go2blocks.spec.ts` PASS, 이어서 `npm test` 및 `npx playwright test` 전체 PASS (기존 인스펙터 e2e 회귀 없음), `npm run build` 성공.
- [ ] **Step 5: 커밋** — `feat(inspector): GO2 블럭 패널 (블럭 선택·값·실제값 표시·트랙 끝 추가)`
