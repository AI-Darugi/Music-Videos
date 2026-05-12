// 실사화 강제 모드 — 모든 이미지/영상 prompt에 photorealistic 규칙 주입.
// STYLE_REALISM=strict (default) | free

export type RealismMode = "strict" | "free";

export function getRealismMode(): RealismMode {
  const m = (process.env.STYLE_REALISM ?? "strict").toLowerCase();
  return m === "free" ? "free" : "strict";
}

export function isStrictRealism(): boolean {
  return getRealismMode() === "strict";
}

/** Claude 기획 단계용 (Stage 03, 06) — 풍부한 가이드라인 */
export function realismGuideline(): string {
  if (!isStrictRealism()) return "";
  return [
    "",
    "★★★ ABSOLUTE REALISM RULE — MUST FOLLOW ★★★",
    "All visual output MUST be PHOTOREALISTIC live-action film aesthetic.",
    "REQUIRED visual characteristics:",
    "  - Real human actors (not characters), real locations, physical materials",
    "  - Shot on actual cinema cameras: 35mm/65mm film, Arri Alexa, RED, IMAX",
    "  - Photorealistic skin (pores, micro-expressions), real fabric, natural light",
    "  - Documentary realism OR cinematic photoreal feature-film quality",
    "ABSOLUTELY FORBIDDEN (never use these styles or words in prompts):",
    "  anime, animation, animated, illustration, painting, drawing, sketch,",
    "  3D render, CGI render, Pixar, Disney, cartoon, cel-shaded, toon-shaded,",
    "  stylized, manga, comic book, graphic novel, digital painting, concept art,",
    "  watercolor, oil painting, vector art, plastic-looking, doll-like, uncanny",
    "When choosing visual_style or writing prompts, reference REAL filmmakers/DPs:",
    "  Roger Deakins, Emmanuel Lubezki, Hoyte van Hoytema, Greig Fraser,",
    "  Bradford Young, Linus Sandgren, Janusz Kamiński",
    "Reference REAL film aesthetics:",
    "  '2010s indie drama film grain', 'Nolan IMAX cinematography',",
    "  '70mm Tarantino-style', 'A24 naturalistic photoreal', 'gritty documentary'",
  ].join("\n");
}

/** gpt-image-2 / Seedance용 — 짧고 강력한 negative prompt */
export function realismNegativeAddon(): string {
  if (!isStrictRealism()) return "";
  return (
    "anime, animation, animated, illustration, painting, drawing, " +
    "3D render, CGI, cartoon, cel-shaded, stylized, manga, comic, " +
    "digital painting, concept art, watercolor, vector art, plastic, " +
    "doll-like, video game graphics"
  );
}

/** prompt 앞단에 강하게 박는 한 줄 */
export function realismPromptPrefix(): string {
  if (!isStrictRealism()) return "";
  return "PHOTOREALISTIC LIVE-ACTION CINEMATIC FILM. Real actors, real locations, shot on 35mm cinema camera. ";
}

/** visual_style 문자열이 실사 모드와 호환되는지 검증 */
export function validateRealisticStyle(visualStyle: string): void {
  if (!isStrictRealism()) return;
  const lower = visualStyle.toLowerCase();
  const banned = [
    "anime",
    "animation",
    "animated",
    "cartoon",
    "illustration",
    "3d render",
    "cgi",
    "manga",
    "stylized",
    "cel-shaded",
    "watercolor",
    "concept art",
    "digital painting",
    "pixar",
  ];
  for (const word of banned) {
    if (lower.includes(word)) {
      throw new Error(
        `STYLE_REALISM=strict인데 visual_style에 금지어 "${word}" 포함됨: "${visualStyle}". Claude가 다시 시도해야 함.`
      );
    }
  }
}
