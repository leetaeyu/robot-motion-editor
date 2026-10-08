# GO2 블럭 편집 설계

- 날짜: 2026-10-08
- 상태: 승인됨 (구현 계획 작성 전)
- 기반: `2026-10-07-robot-motion-editor-design.md`

## 1. 목적

GO2 모션을 Unitree 앱의 그래픽 프로그래밍처럼 **블럭 단위**(Move, Rotate, Stretch, ShowHeart …)로 쌓아 만든다.
블럭은 실로봇 로그 CSV를 템플릿으로 한 **관절 키프레임 클립**으로 변환되어 타임라인에 들어간다.
따라서 뷰어 재생·관절 편집·CSV 내보내기는 기존 경로를 그대로 쓴다.

### 범위

| 포함 | 제외 |
|---|---|
| GO2 선택 시 인스펙터 상단 블럭 패널 | Headlight color (관절과 무관) |
| 고정형 블럭 (파라미터 없음) | Move 후진·좌우 (로그 없음) |
| Move forward (meters), Rotate (± degrees) | 블럭 시퀀스 별도 저장 (타임라인이 곧 시퀀스) |
| 헤더형 CSV 50fps 가져오기 | 명령 블럭의 실로봇 전송 |

### 성공 기준

1. 타임라인에서 GO2 액터 선택 → 인스펙터 상단에 블럭 패널, 아래에 기존 관절 편집. G1 선택 시 화면 변화 없음.
2. 블럭 선택 + 값 입력 + [추가] → 해당 GO2 트랙 맨 끝에 클립 아이템 1개 생성. undo 1회로 원복.
3. Move 1.8m → 루트 전진량이 실제 표시값(주기 배수)과 ±5% 이내 일치, 발 미끄러짐 없음(로그 프레임 그대로 사용).
4. Rotate +/− → 각각 좌/우 회전, 루트 yaw 변화량이 실제 표시값과 ±5° 이내.
5. 블럭으로 만든 클립은 기존 CSV 내보내기에서 그대로 내보내진다.

## 2. 템플릿 데이터

원본: `assets/go2_from_log_cropped/` (gitignore, 실로봇 로그, 헤더형 Unitree CSV, **50fps**, DOF 12).
사용할 테이크만 `public/go2-blocks/`로 복사해 커밋하고 런타임에 `fetch`.

| 블럭 id | 라벨 | 원본 파일 | 종류 |
|---|---|---|---|
| move | Move forward | sport_classicwalk_19700103_142048_g1fmt.csv | 루프 (meters) |
| rotate | Rotate | sport_classicwalk_19700101_084437_g1fmt_spin360.csv | 루프 (degrees, ±) |
| stretch | Stretch | sport_stretch_19700103_133549_g1fmt.csv | 고정 |
| heart | ShowHeart | sport_heart_19700103_131717_g1fmt.csv | 고정 |
| hello | Hello | sport_hello_19700103_131749_g1fmt.csv | 고정 |
| sit | Sit | sport_sit_19700103_144650_g1fmt.csv | 고정 |
| standup | StandUp | sport_standup_19700103_144804_g1fmt.csv | 고정 |
| standdown | StandDown | sport_standdown_19700103_144750_g1fmt.csv | 고정 |
| scrape | Scrape | sport_scrape_19700103_132402_g1fmt.csv | 고정 |
| frontjump | FrontJump | sport_frontjump_19700103_131136_g1fmt.csv | 고정 |
| frontpounce | FrontPounce | sport_frontpounce_19700103_131549_g1fmt.csv | 고정 |
| frontflip | FrontFlip | flip_front_19700103_123206_g1fmt.csv | 고정 |
| backflip | BackFlip | flip_back_19700103_123220_g1fmt.csv | 고정 |
| leftflip | LeftFlip | sport_leftflip_19700103_131924_g1fmt.csv | 고정 |
| rightflip | RightFlip | sport_rightflip_19700103_131924_g1fmt.csv | 고정 |

복사 시 파일명은 블럭 id로 단순화 (`public/go2-blocks/move.csv` …).
spin360 파일은 헤더 끝 빈 열(콤마) 하나가 더 있음 → 기존 헤더 파서가 빈 헤더 셀을 무시하므로 그대로 사용.

### 루프 구간 (사전 분석 결과)

- 걷기: 보행 주기 **35프레임 @50fps (0.7s)**, 정상구간 주기당 전진 ≈ 0.6m (프레임 70~140 부근). 앞은 출발 가속, 뒤는 정지.
- 회전: spin360 로그에 **좌·우 회전 구간이 모두 있음**, 주기 ≈ 36프레임, 주기당 ≈ 72°. 좌회전은 432~684 부근 정상구간, 우회전은 252~360 부근.

정확한 `head / loop / tail` 프레임 경계는 구현 첫 단계에서 다음 기준으로 정해 `blocks.ts`에 하드코딩한다:
- loop 시작·끝 프레임의 관절 자세 차이(12관절 RMS)가 최소인 주기 정수배 구간.
- head 끝 = loop 시작, tail 시작 = loop 끝 (로그상 연속 프레임이므로 경계 자연스러움).
- Rotate 좌/우 각각 별도 `{head, loop, tail}` (같은 파일, 다른 구간). head·tail은 정지 상태 → 회전 진입·종료 구간.

## 3. 블럭 정의 (`src/go2blocks/blocks.ts`)

```ts
type Range = [number, number]                  // [start, end) 원본 50fps 프레임
interface LoopSpec { head: Range; loop: Range; tail: Range }
type Block =
  | { id: string; label: string; file: string; kind: 'fixed' }
  | { id: 'move'; label: string; file: string; kind: 'loop'; param: 'meters'; spec: LoopSpec }
  | { id: 'rotate'; label: string; file: string; kind: 'loop'; param: 'degrees'; left: LoopSpec; right: LoopSpec }
export const GO2_BLOCKS: Block[]
```

## 4. 클립 생성

### 4.1 50fps 가져오기 (`src/export/importCsv.ts`)

헤더형 파서가 fps 30/60만 허용 → **50 추가**. 현재 30→60은 중간점 삽입 전용이므로, fps≠60이면 일반 리샘플로 교체:
60fps 프레임 f → 원본 시간 t = f × fps/60, 앞뒤 행 사이 관절·위치 선형, 루트 쿼터니언 `slerp`. 길이 = floor((n−1) × 60/fps) + 1.
30fps 결과는 기존과 동일(길이 2n−1, 중간점)해야 함 → 기존 테스트로 회귀 확인.
`buildBlockClip`이 원본 행을 쓰도록 파싱(행 배열 반환)과 클립화(리샘플 + 키 생성)를 분리해 export.

### 4.2 `buildBlockClip` (`src/go2blocks/build.ts`, 순수 함수)

입력: 원본 행(포즈 배열, 50fps), 블럭, 값. 출력: `Clip` (robot `go2`, 60fps 키).

- 고정형: 행 전체 → 기존 `csvToClip`과 동일하게 클립화.
- 루프형:
  1. 주기당 이동량 = loop 구간 첫·끝 프레임 루트 변환 차이 (Move: 전진 거리, Rotate: yaw 각도).
  2. `N = max(1, round(|value| / 주기당 이동량))`. Rotate는 부호로 left/right spec 선택.
  3. 포즈열 = head + loop × N + tail. k번째 loop 복사본과 tail에는 "loop 1회 루트 변환"을 k번 누적 적용(`applyXf`).
  4. loop 이음새마다 ~5프레임 `blendPose`로 관절 미세 차이 완화.
  5. 첫 프레임 루트 x·y·yaw를 원점으로 정규화 (z·roll·pitch 유지). 앞 클립과의 연결은 기존 stitch가 처리.
  6. 50→60 리샘플 후 채널별 매 프레임 linear 키 (기존 가져오기와 동일 형태).
- 클립 이름: `Move_1.8m`, `Rotate_-144deg`, `Stretch` (중복 시 기존 규칙대로 `_2` …).

`blockActual(block, value)` → 실제 결과값 (`N × 주기당 이동량`), UI 표시용.

## 5. UI

- `Inspector`: 선택 액터 `robot === 'go2'`일 때 맨 위에 `<Go2BlockPanel actorId>` 렌더. 나머지 인스펙터 그대로. 클립이 없는 GO2 액터("이 액터에 클립이 없습니다")일 때도 패널은 보여야 함 → 패널을 early return보다 먼저 배치.
- `Go2BlockPanel`:
  - 블럭 `<select>`.
  - 루프형이면 숫자 입력 (Move: m, 기본 1.0, 최소 0.1 / Rotate: 도, 기본 90, 음수 = 우회전) + "→ 실제 1.8m (3회)" 표시.
  - [추가] 버튼: CSV fetch(블럭별 1회 캐시) → `buildBlockClip` → `appendClip`. 로딩 중·잠긴 트랙이면 비활성. fetch/파싱 실패 시 패널 안에 오류 문구.

## 6. 스토어

`appendClip(actorId, clip)`: 한 번의 `tryEdit`으로
1. 이름 중복 해소 후 `p.clips[clip.id] = clip`
2. 해당 액터 모션 트랙 끝(`max(item.start + itemLen)`, 비어 있으면 0)에 아이템 추가
→ undo 1단계. 트랙 잠김/액터 없음/로봇 불일치 시 false. 추가 후 새 아이템 선택은 하지 않음(현재 선택 유지).

## 7. 테스트

- 유닛
  - `importCsv`: 헤더형 50fps → 60fps 클립, 길이 = round(n × 60/50) 근처, 첫·끝 포즈 보존.
  - `buildBlockClip`: 고정형 길이; Move N회 루트 전진 ≈ N × 주기당 이동량; Rotate +/− yaw 부호; 첫 프레임 루트 x·y·yaw = 0.
  - `appendClip`: 트랙 끝 배치, 빈 트랙이면 0, 잠긴 트랙 거부, undo 1회 원복.
- e2e: GO2 액터 선택 → 블럭 패널 표시, Move 1.8 추가 → 트랙 끝 아이템 생성. G1 선택 → 패널 없음.
