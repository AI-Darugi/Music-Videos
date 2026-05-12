import fs from "node:fs";
import path from "node:path";
import { generateImage } from "../image-gen";
import { hostImage } from "../image-host";
import { mapLimit } from "../concurrency";
import { realismPromptPrefix, realismNegativeAddon } from "../realism";
import { getVideoMode } from "../clients/fal";
import type { Stage } from "../orchestrator";
import type { Scene, SceneMultishot } from "./06-scene-multishot";
import type { StyleFramework } from "./03-style-framework";
import type { CreativeBrief } from "./04-creative-brief";
import { getActiveCast } from "./04-creative-brief";

const CONCURRENCY = Number(process.env.KEYFRAME_CONCURRENCY ?? "4");
const MOODBOARD_REFS_PER_KEYFRAME = 1;
const MAX_TOTAL_REFS = 5; // gpt-image-2 multi-image input 한도 안전선

type CastSheetInfo = {
  cast_id: string;
  path: string;
  signature: string;
  role: string;
};

function readFullScenes(
  workspaceDir: string,
  fallback: SceneMultishot | undefined
): SceneMultishot {
  // scenes.json은 Stage 06이 풀 데이터로 쓴 파일. ctx.data는 옛 버전이면 요약일 수 있어서 디스크 우선.
  const p = path.join(workspaceDir, "scenes.json");
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as SceneMultishot;
    } catch {
      // 손상 시 fallback
    }
  }
  if (!fallback) throw new Error("scenes 데이터 없음 (Stage 06 결과 누락)");
  return fallback;
}

export type Keyframe = {
  scene_id: string;
  path: string;
  url: string;
  prompt: string;
  cost_krw: number;
};

export const stage: Stage = {
  name: "keyframes",
  label: "키프레임 생성",
  async run({ workspaceDir, data, uploads, emit, job }) {
    // ★ reference-to-video 모드면 키프레임 안 만들고 즉시 종료 (₩3,000 절약)
    // Stage 08이 캐릭터/스타일 시트 + text prompt로 영상 직접 생성
    if (getVideoMode(job.video_mode) === "reference-to-video") {
      emit({
        skipped: true,
        reason: "FAL_VIDEO_MODE=reference-to-video — 키프레임 불필요",
      });
      return {
        data: {
          keyframes: [],
          skipped: true,
          skipped_reason: "reference-to-video 모드 (캐릭터/스타일 시트로 직접 영상 생성)",
        },
        cost_krw: 0,
      };
    }

    const styleData = data["style-framework"] as StyleFramework | undefined;
    const refsData = data["character-style-sheet"] as
      | {
          character_sheets?: Array<{
            cast_id: string;
            cast_role: string;
            path: string;
            url: string;
          }>;
          character_sheet_path?: string | null;
          style_sheet_path: string;
        }
      | undefined;
    const briefData = data["creative-brief"] as CreativeBrief | undefined;
    if (!styleData || !refsData) {
      throw new Error("선행 단계(style/refs) 결과가 누락되었습니다");
    }

    // 활성 cast (사용자 삭제 반영)
    const removed = readRemovedIds(job.cast_overrides);
    const activeCast = briefData ? getActiveCast(briefData, removed) : [];

    // cast_id → 시트 경로 + 시그니처 매핑
    const castInfoById = new Map<string, CastSheetInfo>();
    if (refsData.character_sheets) {
      for (const s of refsData.character_sheets) {
        const member = activeCast.find((c) => c.id === s.cast_id);
        if (!member) continue; // 사용자가 삭제했으면 스킵
        castInfoById.set(s.cast_id, {
          cast_id: s.cast_id,
          path: s.path,
          signature: member.appearance_signature,
          role: s.cast_role,
        });
      }
    } else if (refsData.character_sheet_path) {
      // 옛 jobs 호환: 단일 시트 → lead로 매핑
      const lead = activeCast[0];
      if (lead) {
        castInfoById.set(lead.id, {
          cast_id: lead.id,
          path: refsData.character_sheet_path,
          signature: lead.appearance_signature,
          role: lead.role,
        });
      }
    }

    // scenes는 디스크 우선 (전체 데이터 보장)
    const scenesData = readFullScenes(
      workspaceDir,
      data["scene-multishot"] as SceneMultishot | undefined
    );
    if (!Array.isArray(scenesData.scenes) || scenesData.scenes.length === 0) {
      throw new Error("scenes 배열이 비어있습니다");
    }

    const scenesToGenerate = scenesData.scenes;

    const keyframesDir = path.join(workspaceDir, "keyframes");
    fs.mkdirSync(keyframesDir, { recursive: true });

    const moodboardUsed = uploads.moodboard.paths.length > 0;
    const moodboardSlice = uploads.moodboard.paths.slice(
      0,
      MOODBOARD_REFS_PER_KEYFRAME
    );

    const completed: Keyframe[] = [];

    const results = await mapLimit(
      scenesToGenerate,
      CONCURRENCY,
      async (scene) => {
        const outputPath = path.join(keyframesDir, `${scene.id}.png`);
        // 이 scene에 등장하는 cast의 시트 + 시그니처
        const sceneCastIds = scene.cast_in_scene ?? [];
        const sceneCastInfos = sceneCastIds
          .map((id) => castInfoById.get(id))
          .filter((x): x is CastSheetInfo => Boolean(x));
        const castSheetPaths = sceneCastInfos.map((c) => c.path);
        // ref 우선순위: cast 시트들 > style sheet > moodboard. 총 MAX_TOTAL_REFS 이하.
        const refImages = [
          ...castSheetPaths,
          refsData.style_sheet_path,
          ...moodboardSlice,
        ].slice(0, MAX_TOTAL_REFS);
        const sceneSignatures = sceneCastInfos.map((c) => c.signature);
        const prompt = buildKeyframePrompt(
          scene,
          styleData,
          moodboardUsed,
          sceneSignatures
        );
        const res = await generateImage({
          prompt,
          references: refImages,
          size: sizeFromAspect(styleData.aspect_ratio),
          quality: "medium",
          outputPath,
        });
        const url = await hostImage(outputPath);
        const kf: Keyframe = {
          scene_id: scene.id,
          path: outputPath,
          url,
          prompt,
          cost_krw: res.cost_krw,
        };
        completed.push(kf);
        emit({
          scene_id: scene.id,
          status: "succeeded",
          cost_krw: res.cost_krw,
          completed: completed.length,
          total: scenesToGenerate.length,
        });
        return kf;
      }
    );

    const totalCost = results.reduce((acc, r) => acc + r.cost_krw, 0);

    // scenes.json에 keyframe_url 병합 저장 (다음 단계에서 사용)
    const enriched: SceneMultishot = {
      ...scenesData,
      scenes: scenesData.scenes.map((s) => {
        const kf = results.find((r) => r.scene_id === s.id);
        return kf
          ? ({ ...s, keyframe_path: kf.path, keyframe_url: kf.url } as Scene & {
              keyframe_path: string;
              keyframe_url: string;
            })
          : s;
      }),
    };
    fs.writeFileSync(
      path.join(workspaceDir, "scenes.json"),
      JSON.stringify(enriched, null, 2)
    );

    return {
      data: {
        keyframes: results.map((r) => ({
          scene_id: r.scene_id,
          url: r.url,
          cost_krw: r.cost_krw,
        })),
        moodboard_used: moodboardUsed,
        total_cost_krw: totalCost,
      },
      cost_krw: totalCost,
    };
  },
};

function buildKeyframePrompt(
  scene: Scene,
  style: StyleFramework,
  moodboardUsed: boolean,
  castSignatures: string[]
): string {
  const base =
    scene.image_prompt ??
    scene.scene_prompt ??
    `Cinematic opening frame: ${scene.shots?.[0]?.description ?? scene.narrative_purpose}`;

  const prefix = realismPromptPrefix();
  const realismNeg = realismNegativeAddon();
  const combinedNeg = [style.negative_prompt, realismNeg]
    .filter(Boolean)
    .join(", ");

  // 등장 cast의 시그니처들을 prompt에 명시적으로 박기
  const castCount = castSignatures.length;
  const castLock =
    castCount > 0
      ? `\n\nSUBJECTS (must match exactly across every shot — ${castCount} character${castCount > 1 ? "s" : ""} present):\n` +
        castSignatures.map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
        "\n"
      : "";

  // ref binding 설명
  const refBinding = [
    "",
    "REFERENCE BINDING (do not deviate):",
    castCount > 0
      ? `- The first ${castCount} reference image${castCount > 1 ? "s are" : " is"} the character sheet${castCount > 1 ? "s" : ""}. Each subject's face/hair/outfit must remain identical.`
      : "",
    `- The next reference image is the style sheet — match its visual style, color grading, atmosphere.`,
    moodboardUsed
      ? "- Additional moodboard references should influence color palette and mood."
      : "",
    `- Strict aspect ratio: ${style.aspect_ratio}.`,
    combinedNeg ? `- Avoid (negative): ${combinedNeg}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return prefix + base + castLock + refBinding;
}

function readRemovedIds(castOverridesJson: string | null): string[] {
  if (!castOverridesJson) return [];
  try {
    const parsed = JSON.parse(castOverridesJson) as { removed_ids?: string[] };
    return Array.isArray(parsed.removed_ids) ? parsed.removed_ids : [];
  } catch {
    return [];
  }
}

function sizeFromAspect(
  ar: StyleFramework["aspect_ratio"]
): "1024x1024" | "1792x1024" | "1024x1792" {
  if (ar === "16:9") return "1792x1024";
  if (ar === "9:16") return "1024x1792";
  return "1024x1024";
}
