# AI 뮤직비디오 생성기

Suno 링크나 mp3 파일을 넣으면 AI가 뮤직비디오를 자동으로 만들어줍니다.

- **9단계 파이프라인**: 음악 분석 → 비주얼 기획 → 캐릭터/스타일 시트 → 멀티샷 장면 → 키프레임 → 영상 생성 → ffmpeg 병합
- **일관성 전략 A+C**: 캐릭터 시트 + 스타일 시트로 키프레임 baked-in + 후렴 재활용
- **선택 입력**: 무드보드 1~5장, 주인공 사진 1장(본인만), 가사 평문
- **예상 비용**: 5분 곡 ~3,000~5,000원

## 기술 스택

- Next.js 16.2 (App Router) + React 19.2 + TypeScript + Tailwind 4 + shadcn/ui
- SQLite (better-sqlite3) + SSE 스트리밍
- OpenAI Whisper (STT) + **gpt-image-2** (이미지)
- Anthropic **Claude Sonnet 4.6** (기획 LLM)
- **fal.ai Seedance Lite** (image-to-video, 종량제)
- ffmpeg/ffprobe (병합 + 자막)

## 셋업 순서

### 1. API 키 발급

1. **OpenAI** — [platform.openai.com](https://platform.openai.com) → API keys.
   `gpt-image-2`는 organization verification 필요할 수 있음 (정책상).
2. **Anthropic** — [console.anthropic.com](https://console.anthropic.com).
3. **fal.ai** — [fal.ai](https://fal.ai) → Settings → API Keys.
   - 종량제. 최소 **$5 충전** (BytePlus $30 대비 부담 ↓).
   - 가입 → 카드 등록 → API Key 발급.

### 2. 시스템 의존성

- **Node.js 20+** (24 권장)
- **ffmpeg + ffprobe** (시스템 PATH):
  - Windows: `winget install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
- (선택) 한글 자막용 폰트: Pretendard 또는 Noto Sans CJK KR.

### 3. 의존성 설치 + 환경변수

```bash
npm install
cp .env.local.example .env.local   # Windows: copy .env.local.example .env.local
# 에디터로 .env.local 열어서 키 채우기
```

### 4. 사전 검증 (API 무호출, 무료)

```bash
npm run check-env
```

키 누락/형식, ffmpeg/ffprobe 가용성을 한 번에 검증.

### 5. 개발 서버

```bash
npm run dev
# http://localhost:3000
```

## 환경변수 전체

| 키 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Claude 기획 LLM |
| `OPENAI_API_KEY` | ✅ | — | Whisper + gpt-image-2 공유 |
| `FAL_KEY` | ✅ | — | fal.ai 영상 생성 (Seedance) |
| `FAL_VIDEO_MODEL` | — | `fal-ai/bytedance/seedance/v1/lite/image-to-video` | Pro로 바꾸려면 `.../pro/image-to-video` |
| `FAL_PRICE_PER_SEC_KRW` | — | `100` | 비용 추정 (첫 실행 후 보정) |
| `MAX_BUDGET_KRW` | — | `10000` | 누적 비용 한도 (초과 시 자동 중단) |
| `MAX_SCENES` | — | `4` | Stage 06 최대 멀티샷 장면 수 |
| `IMAGE_HOST_MODE` | — | `data_uri` | OpenAI 이미지 단계용. 영상은 fal.storage 자동 |
| `BLOB_READ_WRITE_TOKEN` | ✅ (Vercel 배포) | — | Vercel Blob 클라이언트 직접 업로드용. **Vercel 대시보드 → Storage → Create → Blob** 만들면 자동 주입. 로컬 dev는 Vercel CLI `vercel env pull .env.local`로 받기. |

## 예상 비용 (5분 곡)

| 항목 | 비용 |
|---|---|
| Whisper STT | ~40원 |
| Claude 기획 (4단계 + alignment) | ~150원 |
| gpt-image-2 캐릭터/스타일 시트 (2장) | ~400원 |
| gpt-image-2 키프레임 (4장) | ~800원 |
| fal.ai Seedance Lite (40초) | ~2,000~4,000원 |
| ffmpeg | 0원 |
| **합계** | **약 3,000~5,000원** |

> 정확한 fal.ai 비용은 첫 실행 후 보정. `FAL_PRICE_PER_SEC_KRW`로 조정 가능.

## 안전장치

- **MAX_BUDGET_KRW**: 누적 비용 한도 넘으면 stage 사이에서 throw.
- **Stage 08 사전 검사**: fal.ai 호출 전 예상 비용으로 검증.
- **부분 재실행**: `POST /api/jobs/[id]/regenerate { stage_name }` — 비용 재계산 후 해당 단계부터.
- **OpenAI 정책 거부 fallback**: 주인공 사진이 거부되면 텍스트 기반 캐릭터로 자동 전환 + UI에 빨간 경고.

## 트러블슈팅

| 증상 | 원인/해결 |
|---|---|
| `Suno 페이지에서 mp3 URL을 찾지 못했습니다` | Suno 페이지 구조 변경 / private 곡. mp3 직접 업로드 fallback 사용. |
| `ffprobe를 찾을 수 없습니다` | ffmpeg 미설치. 위 시스템 의존성 참고. |
| `FAL_KEY 환경변수가 없습니다` | `.env.local`에 키 추가 후 dev 서버 재시작. |
| `fal.ai 응답에 video URL이 없습니다` | 모델 ID 잘못, 또는 fal 잔액 부족. fal.ai 콘솔에서 확인. |
| `Failed to load resource: 413` (업로드 시) | Vercel function의 4.5MB body 한도. **클라이언트가 Vercel Blob으로 직접 업로드**하는 경로로 자동 전환됨 — `BLOB_READ_WRITE_TOKEN` 누락이면 이 에러. Vercel 대시보드에서 Blob store 생성하면 자동 주입. |
| `서버에 BLOB_READ_WRITE_TOKEN이 설정되어 있지 않습니다` | Vercel 대시보드 → Storage → Blob 만들고 재배포. 로컬은 `vercel env pull`. |
| `OpenAI 정책 거부` | 다른 사진으로 재시도. 또는 텍스트 기반 자동 fallback 결과 사용. |
| `MAX_BUDGET_KRW 초과` | 한도 올리거나 `MAX_SCENES` 줄이기. |
| 영상에 한글 자막 깨짐 | 시스템에 Pretendard 또는 Noto Sans CJK KR 설치. |

## 프로젝트 구조

```
ai-mv-generator/
├── app/                              # Next.js App Router
│   ├── page.tsx                      # 메인 입력
│   ├── job/[id]/                     # 진행/결과
│   └── api/jobs/                     # POST/GET/SSE/regenerate
├── lib/
│   ├── db.ts                         # SQLite + 멱등 마이그레이션
│   ├── orchestrator.ts               # 파이프라인 실행기 + StageContext
│   ├── events.ts                     # SSE 이벤트 버스
│   ├── ffprobe.ts, ffmpeg.ts         # 시스템 명령 래퍼
│   ├── image-host.ts                 # 로컬 → 외부 URL (OpenAI용)
│   ├── llm-json.ts                   # markdown fence 제거
│   ├── concurrency.ts                # mapLimit
│   ├── clients/
│   │   ├── anthropic.ts              # Claude
│   │   ├── openai.ts                 # Whisper + gpt-image-2
│   │   └── fal.ts                    # Seedance image-to-video (자체 storage 사용)
│   └── stages/01..09-*.ts            # 9개 stage 모듈
├── workspace/{jobId}/                # 중간 산출물 (gitignore)
└── public/results/{jobId}.mp4        # 완성본 (served)
```

## 라이선스

User-private. 사용자의 음악/이미지/영상 자산은 모두 본인 책임.

## 도움

`AGENTS.md` — Claude Code/AI 보조 작업 시 컨벤션 참조용.
