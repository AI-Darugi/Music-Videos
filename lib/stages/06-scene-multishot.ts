import fs from "node:fs";
import path from "node:path";
import { claudeJson } from "./_claude";
import { realismGuideline } from "../realism";
import type { Stage } from "../orchestrator";

// MAX_SCENES_OVERRIDE: 환경변수로 강제 지정 시 그 값 사용. 미지정이면 음악 분석의 권장치 사용.
const MAX_SCENES_OVERRIDE = process.env.MAX_SCENES_OVERRIDE
  ? Number(process.env.MAX_SCENES_OVERRIDE)
  : null;
const SAFETY_MAX_SCENES = 80; // 비용 안전 상한

export type SceneShot = {
  shot_num: number;
  duration_sec: number;
  description: string;
  camera: string;
};

export type Scene = {
  id: string;
  covers_sections: string[];
  start_sec: number;
  end_sec: number;
  narrative_purpose: string;
  shots: SceneShot[];
  /** 이 scene에 등장하는 cast의 id 배열. 빈 배열이면 인물 없음 (풍경/환경). */
  cast_in_scene: string[];
  /** gpt-image-2 키프레임 생성용 — 매우 상세한 정지 이미지 묘사 */
  image_prompt: string;
  /** fal.ai Seedance image-to-video용 — 동작/카메라 무빙 강조한 간결한 prompt */
  video_prompt: string;
  /** 하위 호환 — 옛 jobs용 */
  scene_prompt?: string;
  reused_in?: string[];
};

export type TimelineEntry = {
  scene_id: string;
  start_sec: number;
  end_sec: number;
};

export type SceneMultishot = {
  scenes: Scene[];
  timeline: TimelineEntry[];
};

export const stage: Stage = {
  name: "scene-multishot",
  label: "장면 멀티샷 기획",
  async run({ workspaceDir, data }) {
    const music = data["music-analysis"] as Record<string, unknown> | undefined;
    const brief = data["creative-brief"] as Record<string, unknown> | undefined;
    const style = data["style-framework"] as Record<string, unknown> | undefined;
    if (!music || !brief || !style) {
      throw new Error("선행 단계(music/brief/style) 결과가 누락되었습니다");
    }
    const duration = Number(music.duration ?? 0);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`곡 길이를 알 수 없습니다: ${duration}`);
    }

    // 동적 scene 개수/길이 결정 (Stage 02 권장 → override → safety 상한)
    const recommendedDuration =
      Number(music.recommended_scene_duration_sec) === 5 ? 5 : 10;
    const recommendedCount = Math.min(
      SAFETY_MAX_SCENES,
      Math.max(2, Number(music.recommended_scene_count) || Math.ceil(duration / recommendedDuration))
    );
    const targetSceneCount =
      MAX_SCENES_OVERRIDE !== null
        ? Math.min(SAFETY_MAX_SCENES, MAX_SCENES_OVERRIDE)
        : recommendedCount;

    const prompt = buildPrompt({
      music,
      brief,
      style,
      duration,
      sceneDurationSec: recommendedDuration,
      targetSceneCount,
    });
    // image_prompt + video_prompt 둘 다 풍부하게 생성하니까 넉넉히
    const tokenBudget = Math.min(64_000, 2000 + targetSceneCount * 1800);
    const result = await claudeJson<SceneMultishot>(prompt, {
      maxTokens: tokenBudget,
    });

    validate(result.value, duration, targetSceneCount, recommendedDuration);
    fs.writeFileSync(
      path.join(workspaceDir, "scenes.json"),
      JSON.stringify(result.value, null, 2)
    );

    return {
      data: {
        scene_count: result.value.scenes.length,
        timeline_blocks: result.value.timeline.length,
        // 전체 scenes 보존 — 다음 stage가 shots/scene_prompt 등 필요로 함
        scenes: result.value.scenes,
        timeline: result.value.timeline,
      },
      cost_krw: result.cost_krw,
    };
  },
};

function buildPrompt(args: {
  music: Record<string, unknown>;
  brief: Record<string, unknown>;
  style: Record<string, unknown>;
  duration: number;
  sceneDurationSec: 5 | 10;
  targetSceneCount: number;
}): string {
  const slotsNeeded = Math.ceil(args.duration / args.sceneDurationSec);
  const canFullyUnique = args.targetSceneCount >= slotsNeeded;
  const reuseGuideline = canFullyUnique
    ? `- 모든 timeline 엔트리가 unique scene이도록 (재활용 없이 ${slotsNeeded}개 슬롯을 ${args.targetSceneCount}개 scene으로 채울 수 있음). 후렴 구간은 비주얼적으로 연속되되 scene_id는 다르게.`
    : `- 곡 길이가 길어서 ${slotsNeeded}개 timeline 슬롯이 필요한데 scene은 ${args.targetSceneCount}개만 만들 수 있음. 같은 scene_id를 timeline에 여러 번 등장시켜 재활용 (특히 후렴 구간).`;

  // Cast 목록 (Stage 04 결과). 신버전: cast 배열. 옛 jobs: protagonist 단일.
  const cast = Array.isArray(args.brief.cast)
    ? (args.brief.cast as Array<{
        id: string;
        role: string;
        appearance_signature: string;
      }>)
    : [];
  const hasCast = cast.length > 0;
  const castListText = hasCast
    ? cast
        .map(
          (c) => `  - id="${c.id}" (${c.role}): "${c.appearance_signature}"`
        )
        .join("\n")
    : "";

  return [
    "뮤직비디오의 장면 구성을 멀티샷 방식으로 작성해주세요.",
    "",
    `곡 길이: ${args.duration.toFixed(1)}초`,
    `템포: ${String(args.music.tempo_feel ?? "?")} (BPM ${args.music.estimated_bpm ?? "?"}) → 씬 길이 ${args.sceneDurationSec}초로 결정`,
    `필요한 timeline 슬롯: ${slotsNeeded}개 (${args.sceneDurationSec}초 단위)`,
    `만들 unique scene: 정확히 ${args.targetSceneCount}개`,
    `각 장면은 ${args.sceneDurationSec}초이며 내부에 2~3컷이 포함됩니다 (fal.ai Seedance Lite는 5초 또는 10초 지원).`,
    hasCast
      ? `\n★★★ CAST LOCK — 등장 인물 ${cast.length}명 (각 scene에 cast_in_scene 필드로 누가 등장하는지 명시. 등장하는 cast의 시그니처는 image_prompt와 video_prompt에 그대로 박을 것):\n${castListText}\n\n시그니처는 한 글자도 바꾸지 말 것. 빠지면 캐릭터 일관성 깨짐.\n`
      : "\n인물 없는 풍경/추상 뮤비 — 각 scene의 cast_in_scene은 빈 배열.\n",
    "",
    "음악 분석:",
    JSON.stringify(args.music, null, 2),
    "",
    "크리에이티브 브리프:",
    JSON.stringify(args.brief, null, 2),
    "",
    "비주얼 스타일:",
    JSON.stringify(args.style, null, 2),
    "",
    "JSON 스키마 (마크다운/설명 절대 금지):",
    `{
  "scenes": [
    {
      "id": "scene_1",
      "covers_sections": ["intro"],
      "start_sec": 0,
      "end_sec": 10,
      "narrative_purpose": "이 장면의 서사적 역할",
      "cast_in_scene": ["lead"],  // 이 scene에 등장하는 cast id. 빈 배열 = 인물 없음 (풍경).
      "shots": [
        { "shot_num": 1, "duration_sec": 5, "description": "...", "camera": "slow dolly in" },
        { "shot_num": 2, "duration_sec": 5, "description": "...", "camera": "handheld pan" }
      ],
      "image_prompt": "gpt-image-2 키프레임 생성용 매우 상세한 prompt (영어, 200-350 단어). 등장 cast의 시그니처를 그대로 포함.",
      "video_prompt": "fal.ai Seedance image-to-video용 간결한 prompt (영어, 80-150 단어). 등장 cast의 시그니처를 그대로 포함.",
      "reused_in": []
    }
  ],
  "timeline": [
    { "scene_id": "scene_1", "start_sec": 0, "end_sec": 10 },
    { "scene_id": "scene_2", "start_sec": 10, "end_sec": 20 }
  ]
}`,
    "",
    "★★★ image_prompt 작성 규칙 (gpt-image-2 — reasoning 모델, 긴 prompt 잘 처리) ★★★",
    "다음 7요소를 모두 채워서 200-350 단어로:",
    "  1. SUBJECT & ACTION: 누가/무엇이 정지 상태로 무엇을 하고 있는지 (감정, 자세, 표정)",
    "  2. COMPOSITION & FRAMING: wide/medium/close, rule of thirds, leading lines, foreground/midground/background",
    "  3. LIGHTING: golden hour / overcast / neon / candlelit / harsh shadow / soft window light 등 구체적으로",
    "  4. COLOR: 위 color_palette의 hex를 자연어로 ('deep teal #0a3540 dominating, warm amber #d4a574 highlights')",
    "  5. CAMERA & LENS: '35mm anamorphic lens, shallow depth of field', '85mm portrait', 'wide-angle 24mm' 등",
    "  6. STYLE & REFERENCE: visual_style 풀어쓰기 + 영화감독/사진작가 이름 (예: 'cinematography by Roger Deakins, Wong Kar-wai color grading')",
    "  7. MOOD & TEXTURE: film grain, anamorphic flare, mist, dust particles, lens distortion 등 분위기 요소",
    "주의:",
    "  - 'beautiful', 'amazing' 같은 추상 형용사 금지 → 구체적 시각 단어로",
    "  - 모순 금지 (예: 'sunny night')",
    "  - 영어로 작성",
    "  - 주인공은 'the same protagonist from the reference character sheet — identical face, hair, outfit' 같이 일관성 명시",
    "",
    "★★★ video_prompt 작성 규칙 (fal.ai Seedance Lite — image-to-video) ★★★",
    `💡 핵심: 입력 이미지가 똑같이 ${args.sceneDurationSec}초 정지하면 안 됨! 내부 multi-shot으로 dynamic하게.`,
    "",
    "구조: 'Shot 1: [opening 동작/카메라]. Cut to Shot 2: [중간 다른 angle/action]. Cut to Shot 3: [closing].' 형식",
    `shots 배열의 description/camera 정보를 활용해서 ${args.sceneDurationSec}초 안에 2~3 cut을 포함시킬 것.`,
    "",
    "각 cut에 다음 요소 포함 (총 80-150 단어):",
    "  1. SUBJECT MOTION (동작 동사): 'slowly turns head', 'walks forward', 'reaches out', 'glances back', 'breathes deeply', 'spins around'",
    "  2. CAMERA MOVEMENT (정확한 영상 용어): 'slow dolly in', 'subtle handheld drift', 'crane up reveal', 'whip pan to', 'rack focus from X to Y', 'orbit around subject', 'tracking shot', 'aerial pullback'",
    "  3. ATMOSPHERIC MOTION: 'wind sweeps grass', 'rain falls steadily', 'dust drifts in beam', 'curtain billows', 'leaves rustle'",
    "  4. CUTS / TRANSITIONS: 'cut to', 'match cut to', 'whip pan to', 'cross-dissolve to'",
    "",
    "예시 (10초 scene):",
    "  'Shot 1 (3s): Wide tracking shot — protagonist walks forward through golden field, wind sweeps grass.",
    "   Cut to Shot 2 (3s): Medium close-up — protagonist looks up at sky, rack focus from face to drifting clouds.",
    "   Match cut to Shot 3 (4s): Extreme close-up — fingertips brush wheat tips, slow handheld push-in.'",
    "",
    "주의:",
    "  - 'static', 'still', 'frozen', 'holds steady throughout' 금지",
    "  - 입력 이미지로 시작하되 즉시 motion + cut이 시작되어야 함",
    "  - 영어로 작성",
    "  - 첫 줄: 'Shot 1: ...' 로 시작",
    "",
    "원칙 (전체):",
    `- 정확히 ${args.targetSceneCount}개의 새 scene을 만드세요 (id는 scene_1, scene_2, ...).`,
    hasCast
      ? `- ★ 각 scene의 cast_in_scene 필드에 등장 cast id 배열 명시. 시그니처는 image_prompt와 video_prompt에 그대로 박을 것 (캐릭터 일관성 lock).`
      : "- 인물 없으므로 cast_in_scene은 모두 빈 배열.",
    reuseGuideline,
    `- timeline 총 시간 합은 곡 길이(${args.duration.toFixed(1)}초)와 ±5초 이내.`,
    `- 각 timeline 엔트리는 (end_sec - start_sec) = ${args.sceneDurationSec}초 권장 (한도).`,
    canFullyUnique
      ? "- scene들이 서사적으로 연결되도록 (단순 나열 X). 곡 진행에 따라 비주얼이 점진적으로 변화/심화."
      : "- 후렴 같은 반복 구간은 같은 scene_id 재활용해 비용 절감.",
    realismGuideline(),
  ].join("\n");
}

function validate(
  s: SceneMultishot,
  duration: number,
  targetSceneCount: number,
  sceneDurationSec: 5 | 10
): void {
  if (!Array.isArray(s.scenes) || s.scenes.length === 0) {
    throw new Error("scenes가 비었습니다");
  }
  if (s.scenes.length > SAFETY_MAX_SCENES) {
    throw new Error(
      `scenes 개수 초과 (안전 상한): ${s.scenes.length} > ${SAFETY_MAX_SCENES}`
    );
  }
  // image_prompt / video_prompt 존재 검증 + cast_in_scene 기본값 보강
  for (const sc of s.scenes) {
    if (!sc.image_prompt && !sc.scene_prompt) {
      throw new Error(`${sc.id}: image_prompt 누락`);
    }
    if (!sc.video_prompt && !sc.scene_prompt) {
      throw new Error(`${sc.id}: video_prompt 누락`);
    }
    if (!Array.isArray(sc.cast_in_scene)) sc.cast_in_scene = [];
  }
  if (!Array.isArray(s.timeline) || s.timeline.length === 0) {
    throw new Error("timeline이 비었습니다");
  }
  const sceneIds = new Set(s.scenes.map((sc) => sc.id));
  for (const t of s.timeline) {
    if (!sceneIds.has(t.scene_id)) {
      throw new Error(`timeline에 존재하지 않는 scene_id: ${t.scene_id}`);
    }
    if (t.end_sec - t.start_sec > sceneDurationSec + 0.5) {
      throw new Error(
        `timeline 엔트리가 ${sceneDurationSec}초 초과: ${t.scene_id} (${t.end_sec - t.start_sec}s)`
      );
    }
  }
  void targetSceneCount; // 현재는 soft target — 검증은 안 함, Claude가 가까운 수치로 만듦
  // 합 검증 (timeline 엔트리들의 길이 합)
  const totalCovered = s.timeline.reduce(
    (acc, t) => acc + (t.end_sec - t.start_sec),
    0
  );
  if (Math.abs(totalCovered - duration) > 5) {
    throw new Error(
      `timeline 길이(${totalCovered.toFixed(
        1
      )}s)가 곡 길이(${duration.toFixed(1)}s)와 5초 이상 차이 납니다`
    );
  }
}
