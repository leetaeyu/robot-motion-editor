# 조각 수정 층(오프셋) 구현 계획

스펙: `docs/superpowers/specs/2026-10-13-piece-offset-design.md` · 대상: Go2-editor 작업 폴더, `Desktop\robot` 합본

- [x] **모델**
  - `Item.offset` 타입 추가.
  - `model/itemClip.ts`: `bakeOffset`, `itemClip`(메모), `offsetKeyCount`.
- [x] **평가 연결**
  - `evaluate`(trackPose·evaluateItem), `stitchTransforms`.
  - 합본만: `withRestPose`(파생 조각의 offset 제거), CSV 덧붙이기.
  - Stage: 조각 프리뷰(`itemId`), 루트 기즈모 각도 연속성.
- [x] **스토어**
  - `layer`/`setLayer`, `clearOffset`.
  - `keyOwner`/`keyTarget`, 키 액션이 조각 ID를 받음(`ownerOf`).
  - `clipLocked`가 조각 ID도 봄.
  - `setValue`: 수정 층에서는 차이값을 기록하고 자동 키가 필요 없음.
  - `keyGroup`, 자르기 시 복사, 클립 길이를 줄일 때 정리, 커밋할 때 빈 층 제거.
- [x] **저장**: `packCurves`로 `items[].offset`을 저장하고, 읽을 때 채널 이름을 검사.
- [x] **UI**
  - 인스펙터: `이 조각 수정`/`원본 클립 수정`, 수정 키 수, `수정 지우기`, 슬라이더 활성 조건.
  - 트랙 보기: 원본 키는 흐리게, 수정 키는 `--piece` 색.
  - 그래프: 결과 곡선과 흐린 원본 곡선을 그리고, 수정 키는 결과 곡선 위에 둠.
  - 시퀀스 막대 아래쪽에 수정 키 눈금.
  - 기즈모 안내 문구는 `원본 클립 수정`일 때만.
- [x] **테스트**
  - `model/itemClip.test.ts`(11개).
  - 기존 스토어 테스트는 원본 클립 편집을 시험하므로 `setLayer('clip')`을 추가.
  - e2e `pieceOffset.spec.ts`.
- [x] **확인**: 두 폴더 모두 tsc, 단위 테스트, e2e, 브라우저 수동 확인.
