import fs from "node:fs";
import path from "node:path";
import { claudeJson, type ClaudeImageRef } from "./_claude";
import {
  realismGuideline,
  realismNegativeAddon,
  validateRealisticStyle,
} from "../realism";
import type { Stage } from "../orchestrator";

export type StyleFramework = {
  visual_style: string;
  color_palette: string[];
  camera_style: string;
  lighting: string;
  aspect_ratio: "16:9" | "9:16" | "1:1";
  reference_directors: string[];
  negative_prompt: string;
  moodboard_influence?: string;
};

// 무드보드 토큰 폭증 방지 — Claude에 보낼 무드보드 이미지 최대 개수
const MAX_MOODBOARD_TO_CLAUDE = 5;

export const stage: Stage = {
  name: "style-framework",
  label: "스타일 프레임워크",
  async run({ workspaceDir, data, uploads }) {
    const music = data["music-analysis"] as Record<string, unknown> | undefined;
    if (!music) throw new Error("음악 분석 결과가 없습니다 (Stage 02 선행 필요)");

    const moodboardPaths = uploads.moodboard.paths.slice(0, MAX_MOODBOARD_TO_CLAUDE);
    const images: ClaudeImageRef[] = moodboardPaths.map((p) => ({ path: p }));
    const hasMoodboard = images.length > 0;

    const prompt = buildPrompt(music, hasMoodboard);
    const result = await claudeJson<StyleFramework>(prompt, {
      maxTokens: 3000,
      images,
    });

    validate(result.value);
    validateRealisticStyle(result.value.visual_style);

    // 실사 모드면 negative_prompt에 강력한 anti-anime 추가
    const realismNeg = realismNegativeAddon();
    if (realismNeg) {
      result.value.negative_prompt = result.value.negative_prompt
        ? `${result.value.negative_prompt}, ${realismNeg}`
        : realismNeg;
    }

    // 무드보드 없으면 moodboard_influence 강제 제거 (Claude가 채워서 보내는 경우)
    if (!hasMoodboard) {
      delete result.value.moodboard_influence;
    }

    fs.writeFileSync(
      path.join(workspaceDir, "style.json"),
      JSON.stringify(result.value, null, 2)
    );

    return {
      data: {
        ...result.value,
        moodboard_used: hasMoodboard,
        moodboard_count: moodboardPaths.length,
        skipped_images: result.skipped_images,
      },
      cost_krw: result.cost_krw,
    };
  },
};

function buildPrompt(
  music: Record<string, unknown>,
  hasMoodboard: boolean
): string {
  const intro = hasMoodboard
    ? [
        "다음은 사용자가 제공한 무드보드 이미지들입니다.",
        "이 이미지들의 색감, 조명, 구도, 분위기를 분석해서 음악 분석과 종합한 비주얼 스타일을 결정해주세요.",
      ].join("\n")
    : "음악 분석을 바탕으로 뮤직비디오의 비주얼 스타일을 결정해주세요.";

  const moodFields = hasMoodboard
    ? `,\n  "moodboard_influence": "무드보드에서 가져온 핵심 요소 2-3개 (예: 'cool blue tones, soft window light')"`
    : "";

  return [
    intro,
    "",
    "음악 분석:",
    JSON.stringify(music, null, 2),
    "",
    "다음 JSON 스키마로만 응답하세요 (마크다운/설명 금지):",
    `{
  "visual_style": "예: 90s film grain handheld, cyberpunk neon, photorealistic cinematic, anime",
  "color_palette": ["#hex", "#hex", "#hex", "#hex"],
  "camera_style": "예: handheld documentary, dolly cinematic, locked-off static",
  "lighting": "예: golden hour soft, neon harsh night, overcast diffused",
  "aspect_ratio": "16:9 | 9:16 | 1:1",
  "reference_directors": ["감독/뮤비감독 2-3명"],
  "negative_prompt": "피해야 할 요소를 콤마 구분으로"${moodFields}
}`,
    "",
    "원칙:",
    "- 곡 무드와 일치해야 함",
    "- color_palette는 4개의 #RRGGBB hex 코드",
    "- aspect_ratio는 정확히 셋 중 하나",
    hasMoodboard
      ? "- 무드보드 이미지의 색감/조명을 color_palette와 lighting에 반영"
      : "",
    realismGuideline(),
  ]
    .filter(Boolean)
    .join("\n");
}

function validate(s: StyleFramework): void {
  if (!s.visual_style) throw new Error("style.visual_style 누락");
  if (!Array.isArray(s.color_palette) || s.color_palette.length === 0) {
    throw new Error("style.color_palette 누락");
  }
  if (!["16:9", "9:16", "1:1"].includes(s.aspect_ratio)) {
    throw new Error(`style.aspect_ratio 잘못된 값: ${s.aspect_ratio}`);
  }
}
