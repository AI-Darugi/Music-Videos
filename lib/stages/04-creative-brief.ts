import fs from "node:fs";
import path from "node:path";
import { claudeJson } from "./_claude";
import type { Stage } from "../orchestrator";

export type CastMember = {
  /** 영문 식별자: "lead" | "lover" | "child" | "band_drummer" 등 */
  id: string;
  /** 역할 한국어 라벨: "주인공", "연인" 등 */
  role: string;
  /** 상세 외모 (캐릭터 시트 생성용, 3-5 문장) */
  appearance: string;
  /** 1줄 영어 시그니처 (모든 scene prompt에 박혀 일관성 lock) */
  appearance_signature: string;
  /** 성격 1줄 */
  personality: string;
  /** 의상 (영화 전체 동일 권장) */
  wardrobe: string;
};

/** Stage 04 결과 (구버전: protagonist 1명 / 신버전: cast 배열) */
export type CreativeBrief = {
  concept: string;
  narrative_arc: string;
  /** 신버전 — 0~5명의 cast. 빈 배열이면 추상/풍경 뮤비 */
  cast: CastMember[];
  /** 하위 호환: 옛 jobs용. 신규 jobs는 cast 사용 */
  protagonist?: {
    exists: boolean;
    appearance?: string;
    appearance_signature?: string;
    personality?: string;
    wardrobe?: string;
  };
  setting: {
    primary_location: string;
    secondary_locations: string[];
    world_description: string;
  };
  themes: string[];
  visual_motifs: string[];
};

const MAX_CAST = 5;

export const stage: Stage = {
  name: "creative-brief",
  label: "크리에이티브 브리프",
  async run({ workspaceDir, data }) {
    const music = data["music-analysis"] as Record<string, unknown> | undefined;
    const style = data["style-framework"] as Record<string, unknown> | undefined;
    if (!music) throw new Error("음악 분석 결과가 없습니다");
    if (!style) throw new Error("스타일 결과가 없습니다");

    const prompt = buildPrompt(music, style);
    const result = await claudeJson<CreativeBrief>(prompt, { maxTokens: 6000 });

    validate(result.value);
    fs.writeFileSync(
      path.join(workspaceDir, "brief.json"),
      JSON.stringify(result.value, null, 2)
    );

    return { data: result.value, cost_krw: result.cost_krw };
  },
};

function buildPrompt(
  music: Record<string, unknown>,
  style: Record<string, unknown>
): string {
  return [
    "음악 분석과 비주얼 스타일을 바탕으로 뮤직비디오의 크리에이티브 브리프를 작성해주세요.",
    "",
    "음악 분석:",
    JSON.stringify(music, null, 2),
    "",
    "비주얼 스타일:",
    JSON.stringify(style, null, 2),
    "",
    "다음 JSON 스키마로만 응답하세요 (마크다운/설명 금지):",
    `{
  "concept": "한 문장 핵심 컨셉",
  "narrative_arc": "기-승-전-결 3-4 문장 스토리",
  "cast": [
    {
      "id": "lead",
      "role": "주인공 (한국어 라벨)",
      "appearance": "상세 외모 묘사 3-5문장. 나이, 인종, 얼굴형, 눈색, 머리, 피부, 체형, 표정, 분위기, 의상까지. gpt-image-2가 캐릭터 시트 만들 정도로 구체적으로.",
      "appearance_signature": "★ 모든 scene prompt에 박힐 1줄 영어 식별 문구 (30-50 단어). 얼굴/머리/의상 핵심 특징. 예: '28-year-old Korean woman, oval face, shoulder-length black hair with blunt bangs, dark brown eyes, fair skin, cream knit sweater'.",
      "personality": "성격 1줄",
      "wardrobe": "의상 (영화 전체 동일 유지 권장)"
    }
  ],
  "setting": {
    "primary_location": "주 배경",
    "secondary_locations": ["보조 배경 2-3개"],
    "world_description": "세계관 2줄"
  },
  "themes": ["테마 3개"],
  "visual_motifs": ["반복될 시각적 모티프 3-5개"]
}`,
    "",
    "★★★ Cast 결정 규칙 ★★★",
    `- 곡 가사/컨셉 분석해서 등장 인물 수 결정 (0~${MAX_CAST}명).`,
    "- 가사가 1인칭 독백/관조면 cast 1명 (lead만).",
    "- 가사에 너/그/그녀 등 다른 인물이 있으면 lead + lover/friend/other.",
    "- 가족/그룹 서사면 lead + family_member들 또는 band_member들.",
    "- 추상/풍경 뮤비라고 판단되면 cast: [] 빈 배열.",
    "- 각 cast의 id는 영문 소문자_언더스코어 (예: lead, lover, child_1, child_2, band_drummer).",
    "- 각 cast의 appearance_signature는 30-50 단어 영어, 매 scene prompt에 그대로 박힐 anchor.",
    "",
    "★ wardrobe는 영화 전체에서 동일 유지 (의상 바뀌면 캐릭터 동일성 깨짐).",
  ].join("\n");
}

function validate(b: CreativeBrief): void {
  if (!b.concept) throw new Error("brief.concept 누락");
  if (!b.narrative_arc) throw new Error("brief.narrative_arc 누락");
  if (!b.setting?.primary_location) throw new Error("brief.setting.primary_location 누락");
  if (!Array.isArray(b.cast)) throw new Error("brief.cast가 배열이 아닙니다");
  if (b.cast.length > MAX_CAST) {
    throw new Error(`brief.cast 최대 ${MAX_CAST}명: 받은 ${b.cast.length}명`);
  }
  for (const c of b.cast) {
    if (!c.id) throw new Error(`cast.id 누락`);
    if (!/^[a-z][a-z0-9_]*$/.test(c.id))
      throw new Error(`cast.id "${c.id}"는 영문 소문자_언더스코어만`);
    if (!c.appearance) throw new Error(`cast[${c.id}].appearance 누락`);
    if (!c.appearance_signature)
      throw new Error(`cast[${c.id}].appearance_signature 누락 (캐릭터 lock anchor)`);
  }
  // id 중복 검사
  const ids = new Set(b.cast.map((c) => c.id));
  if (ids.size !== b.cast.length) {
    throw new Error("cast 안에 중복된 id가 있습니다");
  }
}

/**
 * cast_overrides (사용자 삭제 목록)을 적용한 active cast 반환.
 * 옛 jobs용 fallback: brief.protagonist가 있고 cast가 비면 단일 cast로 변환.
 */
export function getActiveCast(
  brief: CreativeBrief,
  removedIds: string[] = []
): CastMember[] {
  let cast = Array.isArray(brief.cast) ? brief.cast : [];
  // 옛 jobs 호환
  if (cast.length === 0 && brief.protagonist?.exists) {
    cast = [
      {
        id: "lead",
        role: "주인공",
        appearance: brief.protagonist.appearance ?? "",
        appearance_signature: brief.protagonist.appearance_signature ?? "",
        personality: brief.protagonist.personality ?? "",
        wardrobe: brief.protagonist.wardrobe ?? "",
      },
    ];
  }
  if (removedIds.length === 0) return cast;
  const removed = new Set(removedIds);
  return cast.filter((c) => !removed.has(c.id));
}
