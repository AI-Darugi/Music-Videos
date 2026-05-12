<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AI 뮤직비디오 생성기 (ai-mv-generator)

Suno 링크 또는 mp3 → 9단계 AI 파이프라인 → 완성 mp4.
선택 입력: 무드보드 1~5장, 주인공 사진 1장(본인만), 가사 평문.

## 모델 스택 (변경 금지)

| 용도 | 모델 | SDK / Endpoint |
|---|---|---|
| 이미지 생성 | OpenAI **gpt-image-2** | `openai` SDK (`lib/clients/openai.ts`) |
| 영상 생성 | **fal.ai Seedance Lite** (image-to-video) | `@fal-ai/client` (`lib/clients/fal.ts`) |
| 음성 인식 | OpenAI **whisper-1** | 같은 openai 클라이언트 |
| 기획 LLM | Anthropic **claude-sonnet-4-6** | `@anthropic-ai/sdk` |

**fal.ai 영상 모델**: 환경변수 `FAL_VIDEO_MODEL`로 변경 가능 (기본 Lite). Pro로 업그레이드 시 `fal-ai/bytedance/seedance/v1/pro/image-to-video`.

> **금지**: BytePlus, Veo, Replicate, Runway 등 위 외 모델 제안/사용. 가격 비교 이후 fal.ai로 확정됨 (BytePlus는 $30 선결제 부담, Veo는 단가 비쌈).

## 일관성 전략 A+C (수정됨)

- **A** — Stage 05에서 캐릭터 시트 + 스타일 시트 ref 2장 생성 (gpt-image-2).
  Stage 07에서 키프레임 생성 시 이 ref + 무드보드를 multi-image input으로 → **키프레임이 이미 캐릭터/스타일 일관성을 baked-in 상태**.
- **C** — 곡을 4개 멀티샷 장면으로 그루핑 (10초 × 4 = 40초 unique, timeline에서 재활용). Stage 08은 키프레임 1장 + 강화 prompt로 영상 생성. fal.ai Seedance Lite는 **image_url 1장만** 받기 때문에 멀티 ref는 prompt 텍스트로 풀어 담음.

## 9 stages (lib/stages/)

```
01-input-analysis        URL 검증 + Suno mp3 다운로드 + ffprobe duration
02-music-analysis        Whisper STT + (가사 있으면) Claude alignment + 구조 분석
03-style-framework       Claude → visual_style/palette/camera (무드보드 멀티모달)
04-creative-brief        Claude → concept/protagonist/setting
05-character-style-sheet ★ gpt-image-2로 ref 2장 (주인공 사진/무드보드 활용 + 정책 fallback)
06-scene-multishot       Claude → 4 scene + timeline (각 10초, 재활용)
07-keyframes             gpt-image-2 멀티 ref → scene별 시작 이미지
08-video-generation      fal.ai Seedance Lite (image_url=keyframe + 강화 prompt)
09-merge                 ffmpeg concat + 원곡 + 자막 burn-in + finalize
```

각 stage 모듈은 `Stage` 인터페이스 (`lib/orchestrator.ts`) 구현. `run(ctx)` → `{ data, cost_krw }`.

**Scene/timeline 길이 제한**: fal.ai Seedance Lite는 **5 또는 10초**만 지원. Stage 06 timeline 엔트리 max 10초.

## 선택 입력 (uploads + lyrics)

`StageContext.uploads`와 `StageContext.userLyrics`로 stage 모듈에 노출:

```ts
uploads: {
  moodboard: { paths: string[], urls: string[] },
  protagonist: { path: string | null, url: string | null }
}
userLyrics: string | null
```

DB 컬럼: `jobs.moodboard_paths`, `moodboard_urls`, `protagonist_path`, `protagonist_url`, `user_lyrics`. 업로드는 `POST /api/jobs` multipart에서 처리.

**주인공 사진**: 반드시 본인만. UI에 동의 체크박스 강제. OpenAI 정책 거부 시 Stage 05가 자동으로 텍스트 기반 fallback + `policy_warning`.

**무드보드 활용**:
- Stage 03 (style-framework): Claude 멀티모달 분석
- Stage 05 (character-style-sheet): gpt-image-2 ref로 1~2장 추가
- Stage 07 (keyframes): gpt-image-2 multi-image input에 1~2장 추가
- Stage 08 (video-generation): **prompt 텍스트에 묘사 추가** (fal.ai는 image_url 1장만)

**사용자 가사**: Stage 02에서 Whisper 타임스탬프와 Claude로 정렬 → `aligned_segments`. 한국어 곡 강력 권장.

## 이미지 호스팅 (단순화됨)

`lib/image-host.ts`의 `hostImage()` — `IMAGE_HOST_MODE`로 모드 선택. **OpenAI 이미지 단계 용도**:

- `data_uri`: base64 data URI. OpenAI 이미지 생성/edit에 작동.
- `public`: `public/hosted/` 복사 + `NEXT_PUBLIC_BASE_URL`로 외부 접근 가능.

**Stage 08 (fal.ai 영상)**: `lib/clients/fal.ts`의 `uploadImage()` → `fal.storage.upload()`로 키프레임 직접 업로드 → fal.ai가 반환한 URL 사용. **ngrok / 외부 호스팅 불필요** (BytePlus 시절 대비 큰 장점).

## Next.js 16 컨벤션

- **동적 라우트 params는 Promise**: 무조건 `const { id } = await params`. 잊으면 런타임 에러.
- **API 라우트 Node 런타임**: better-sqlite3 + fs 사용 → `export const runtime = "nodejs"` 명시.
- **SSE 라우트**: `export const dynamic = "force-dynamic"` + `Content-Type: text/event-stream`.

## SSE 이벤트 버스

`lib/events.ts`. `globalThis`에 subscriber 맵 보관 (Next dev hot-reload 대응).

이벤트 타입: `snapshot` / `stage_started` / `stage_progress` / `stage_completed` / `stage_failed` / `job_completed` / `job_failed`.

Terminal 이벤트 후 cleanup() (clearInterval + unsubscribe + close) 명시 호출 필수.

## 비용 안전장치

- `MAX_BUDGET_KRW` (env, default 10000) 초과 시 orchestrator가 throw.
- Stage 08은 시작 전 `estimateVideoCost`로 사전 검사.
- 부분 재실행은 `total_cost_krw`를 남은 stage들의 합으로 재계산 (이중 카운트 방지).

## 부분 재실행 (regenerate)

```
POST /api/jobs/[id]/regenerate
{ "stage_name": "character-style-sheet" }
```

해당 stage 이후 모든 stage_logs 삭제 + total_cost_krw 재계산 + 그 단계부터 재실행.

## DB 스키마 (better-sqlite3)

`workspace/jobs.db` (WAL). `getDb()` 호출 시 자동 migration (`ensureColumn`으로 멱등 ALTER).

## 환경변수

`.env.local.example` 참조. 핵심:
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- `FAL_KEY`, `FAL_VIDEO_MODEL` (옵션), `FAL_PRICE_PER_SEC_KRW` (옵션)
- `MAX_BUDGET_KRW=10000`, `MAX_SCENES=4`
- `IMAGE_HOST_MODE=data_uri` (default 충분)

`npm run check-env`로 사전 검증.

## 시스템 요구사항

- Node.js 20+ (24 OK)
- ffmpeg + ffprobe (시스템 PATH)
- 한글 자막용 폰트 (Pretendard 또는 Noto Sans CJK KR — 선택)

## 작업 시 주의

- **단계 추가/제거 금지** (9단계 고정)
- **모델 교체 금지** (위 표 외). 사용자가 가격 비교 후 fal.ai Seedance Lite로 확정.
- **fal.ai SDK 사용 패턴**: `fal.config({credentials})` → `fal.storage.upload(blob)` → `fal.subscribe(model, {input})`. `lib/clients/fal.ts`의 헬퍼 함수 사용.
- **Stage 08 단일 image 한계**: prompt에 캐릭터/스타일/무드보드 텍스트 묘사 풍부하게. multi-image 시도 금지.
- LLM JSON 응답은 markdown ```json``` 감싸짐 → `lib/llm-json.ts`의 `parseLlmJson` 사용
- 다중 이미지 처리는 `concurrency.ts`의 `mapLimit` 사용 (gpt-image-2 2개, Seedance 순차)
