import fs from "node:fs";
import path from "node:path";
import { generateImage } from "../image-gen";
import { hostImage } from "../image-host";
import { mapLimit } from "../concurrency";
import {
  realismGuideline,
  realismNegativeAddon,
  realismPromptPrefix,
} from "../realism";
import type { Stage } from "../orchestrator";
import {
  getActiveCast,
  type CastMember,
  type CreativeBrief,
} from "./04-creative-brief";
import type { StyleFramework } from "./03-style-framework";

type ImageSize = "1024x1024" | "1792x1024" | "1024x1792";

const MOODBOARD_REFS_FOR_CHARACTER = 1;
const MOODBOARD_REFS_FOR_STYLE = 2;
const SHEET_CONCURRENCY = 3; // 동시에 생성할 캐릭터 시트 수

export type CharacterSheet = {
  cast_id: string;
  cast_role: string;
  path: string;
  url: string;
  prompt: string;
  source: "uploaded_photo" | "generated" | "abstract_moodboard";
  policy_warning: string | null;
  cost_krw: number;
};

export const stage: Stage = {
  name: "character-style-sheet",
  label: "캐릭터 & 스타일 시트",
  async run({ workspaceDir, data, uploads, job }) {
    const brief = data["creative-brief"] as CreativeBrief | undefined;
    const style = data["style-framework"] as StyleFramework | undefined;
    if (!brief) throw new Error("크리에이티브 브리프가 없습니다");
    if (!style) throw new Error("스타일이 없습니다");

    const removed = readRemovedCastIds(job.cast_overrides);
    const activeCast = getActiveCast(brief, removed);
    const hasCast = activeCast.length > 0;

    const refsDir = path.join(workspaceDir, "refs");
    fs.mkdirSync(refsDir, { recursive: true });

    // 무드보드 ref (캐릭터/스타일 시트 공용)
    const characterMoodRefs = uploads.moodboard.paths.slice(
      0,
      MOODBOARD_REFS_FOR_CHARACTER
    );
    const styleMoodRefs = uploads.moodboard.paths.slice(
      0,
      MOODBOARD_REFS_FOR_STYLE
    );

    // ============ 1) 캐릭터 시트 생성 (cast 인원수만큼, 병렬) ============
    const characterSheets: CharacterSheet[] = hasCast
      ? await mapLimit(activeCast, SHEET_CONCURRENCY, async (member, idx) =>
          generateOneCharacterSheet({
            member,
            isLead: idx === 0,
            style,
            refsDir,
            uploads,
            characterMoodRefs,
          })
        )
      : [];

    // ============ 2) 스타일 시트 (1장, 인물 없는 환경/풍경) ============
    const stylePath = path.join(refsDir, "style-sheet.png");
    const stylePrompt = buildStylePrompt(brief, style, uploads.moodboard.paths.length > 0);
    const styleResult =
      styleMoodRefs.length > 0
        ? await generateImage({
            prompt: stylePrompt,
            references: styleMoodRefs,
            size: sizeFromAspect(style.aspect_ratio),
            quality: "medium",
            outputPath: stylePath,
          })
        : await generateImage({
            prompt: stylePrompt,
            size: sizeFromAspect(style.aspect_ratio),
            quality: "medium",
            outputPath: stylePath,
          });
    const style_sheet_url = await hostImage(stylePath);

    const totalCost =
      characterSheets.reduce((acc, s) => acc + s.cost_krw, 0) + styleResult.cost_krw;

    // 구버전 호환 키 (Stage 07/08가 character_sheet_path 단일 키 폴백 사용)
    const firstSheet = characterSheets[0];

    return {
      data: {
        character_sheets: characterSheets.map((s) => ({
          cast_id: s.cast_id,
          cast_role: s.cast_role,
          path: s.path,
          url: s.url,
          source: s.source,
          policy_warning: s.policy_warning,
        })),
        // 구버전 호환 (Stage 07/08가 이 키 폴백 사용)
        character_sheet_path: firstSheet?.path ?? null,
        character_sheet_url: firstSheet?.url ?? null,
        style_sheet_path: stylePath,
        style_sheet_url,
        style_prompt: stylePrompt,
        moodboard_used: uploads.moodboard.paths.length > 0,
        cast_count: characterSheets.length,
      },
      cost_krw: totalCost,
    };
  },
};

export async function generateOneCharacterSheet(args: {
  member: CastMember;
  isLead: boolean;
  style: StyleFramework;
  refsDir: string;
  uploads: { protagonist: { path: string | null }; moodboard: { paths: string[] } };
  characterMoodRefs: string[];
}): Promise<CharacterSheet> {
  const { member, isLead, style, refsDir, uploads, characterMoodRefs } = args;
  const outputPath = path.join(refsDir, `character-sheet-${member.id}.png`);
  // 주인공 사진 업로드는 lead(첫 cast)에만 적용
  const useProtagonistPhoto = isLead && Boolean(uploads.protagonist.path);
  const prompt = buildCharacterPrompt(member, style, useProtagonistPhoto);

  let policyWarning: string | null = null;
  let source: CharacterSheet["source"] = "generated";

  try {
    let result;
    if (useProtagonistPhoto) {
      const refs: string[] = [uploads.protagonist.path!];
      for (const p of characterMoodRefs) refs.push(p);
      result = await generateImage({
        prompt,
        references: refs,
        size: "1792x1024",
        quality: "medium",
        outputPath,
      });
      source = "uploaded_photo";
    } else {
      result = await generateImage({
        prompt,
        size: "1792x1024",
        quality: "medium",
        outputPath,
      });
    }
    const url = await hostImage(outputPath);
    return {
      cast_id: member.id,
      cast_role: member.role,
      path: outputPath,
      url,
      prompt,
      source,
      policy_warning: null,
      cost_krw: result.cost_krw,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (useProtagonistPhoto && isLikelyPolicyError(msg)) {
      policyWarning = `${member.role}: 업로드 사진이 OpenAI 정책으로 거부됨. 텍스트 기반으로 fallback.`;
      const fallbackPrompt = buildCharacterPrompt(member, style, false);
      const result = await generateImage({
        prompt: fallbackPrompt,
        size: "1792x1024",
        quality: "medium",
        outputPath,
      });
      const url = await hostImage(outputPath);
      return {
        cast_id: member.id,
        cast_role: member.role,
        path: outputPath,
        url,
        prompt: fallbackPrompt,
        source: "generated",
        policy_warning: policyWarning,
        cost_krw: result.cost_krw,
      };
    }
    throw e;
  }
}

function buildCharacterPrompt(
  member: CastMember,
  style: StyleFramework,
  hasProtagonistPhoto: boolean
): string {
  const prefix = realismPromptPrefix();
  const realismNeg = realismNegativeAddon();
  const combinedNeg = [style.negative_prompt, realismNeg].filter(Boolean).join(", ");

  if (hasProtagonistPhoto) {
    return [
      prefix,
      `Character sheet showing this exact person (reference image 1) in three views:`,
      `front full body on the left, side profile in the center, close-up portrait on the right.`,
      `Maintain the person's likeness — same face structure, hairstyle, and overall appearance — across all three views.`,
      `Identity (must match): ${member.appearance_signature}.`,
      `Wardrobe: ${member.wardrobe || "natural attire matching the music style"}.`,
      `Personality expression: ${member.personality}.`,
      `Visual style: ${style.visual_style}.`,
      `Lighting: ${style.lighting}.`,
      `Color palette: ${style.color_palette.join(", ")}.`,
      `Plain neutral studio background. High detail, production reference quality.`,
      combinedNeg ? `Avoid: ${combinedNeg}.` : "",
      realismGuideline(),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    prefix,
    `Character sheet of: ${member.appearance}.`,
    `Identity signature (anchor): ${member.appearance_signature}.`,
    `Three views in a single image: full body front on left, side profile center, close-up portrait right.`,
    `Plain neutral studio background. Consistent character design across all three views — same face, hair, outfit.`,
    `Wardrobe: ${member.wardrobe || "natural attire"}.`,
    `Personality cue: ${member.personality}.`,
    `Visual style: ${style.visual_style}.`,
    `Lighting: ${style.lighting}.`,
    `Color palette: ${style.color_palette.join(", ")}.`,
    `Production reference quality, high detail.`,
    combinedNeg ? `Avoid: ${combinedNeg}.` : "",
    realismGuideline(),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildStylePrompt(
  brief: CreativeBrief,
  style: StyleFramework,
  hasMoodboard: boolean
): string {
  const prefix = realismPromptPrefix();
  const realismNeg = realismNegativeAddon();
  const combinedNeg = [style.negative_prompt, realismNeg].filter(Boolean).join(", ");
  return [
    prefix,
    `Cinematic wide establishing shot of: ${brief.setting.primary_location}.`,
    brief.setting.world_description
      ? `World context: ${brief.setting.world_description}.`
      : "",
    `Visual style: ${style.visual_style}.`,
    `Lighting: ${style.lighting}.`,
    `Color palette: ${style.color_palette.join(", ")}.`,
    hasMoodboard
      ? `Color tone and atmospheric mood should match the reference moodboard images.`
      : "",
    style.reference_directors?.length
      ? `Cinematography inspired by: ${style.reference_directors.join(", ")}.`
      : "",
    `Aspect ratio: ${style.aspect_ratio}.`,
    `Atmospheric mood: ${style.camera_style}. No characters, no people — landscape/environment focus.`,
    `Reference quality production still, high detail.`,
    combinedNeg ? `Avoid: ${combinedNeg}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sizeFromAspect(ar: StyleFramework["aspect_ratio"]): ImageSize {
  if (ar === "16:9") return "1792x1024";
  if (ar === "9:16") return "1024x1792";
  return "1024x1024";
}

function isLikelyPolicyError(msg: string): boolean {
  const lc = msg.toLowerCase();
  return (
    lc.includes("policy") ||
    lc.includes("safety") ||
    lc.includes("content_policy") ||
    lc.includes("violates") ||
    lc.includes("rejected") ||
    lc.includes("400")
  );
}

function readRemovedCastIds(castOverridesJson: string | null): string[] {
  if (!castOverridesJson) return [];
  try {
    const parsed = JSON.parse(castOverridesJson) as {
      removed_ids?: string[];
    };
    return Array.isArray(parsed.removed_ids) ? parsed.removed_ids : [];
  } catch {
    return [];
  }
}
