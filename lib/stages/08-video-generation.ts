import fs from "node:fs";
import path from "node:path";
import {
  downloadVideo,
  estimateVideoCost,
  generateVideo,
  generateVideoWithRefs,
  getVideoMode,
  uploadImage,
} from "../clients/fal";
import { mapLimit } from "../concurrency";
import { realismPromptPrefix, realismNegativeAddon } from "../realism";
import type { Stage } from "../orchestrator";
import type { Scene, SceneMultishot } from "./06-scene-multishot";
import type { StyleFramework } from "./03-style-framework";
import {
  getActiveCast,
  type CreativeBrief,
  type CastMember,
} from "./04-creative-brief";

// scene 길이는 음악 분석에서 결정 (5 또는 10). default 10.
const RETRIES_PER_SCENE = 3; // 503 등 transient 에러 흡수
const VIDEO_CONCURRENCY = Number(process.env.VIDEO_CONCURRENCY ?? "3");

// 5xx / 503 / rate limit 같은 transient 에러인지
function isTransientError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /HTTP 5\d\d/i.test(msg) ||
    /Service.*Unavailable/i.test(msg) ||
    /timeout/i.test(msg) ||
    /ECONNRESET|ETIMEDOUT|ENETUNREACH/i.test(msg) ||
    /429/i.test(msg) ||
    /rate limit/i.test(msg)
  );
}

type SceneClip = {
  scene_id: string;
  clip_path: string;
  cost_krw: number;
  duration_sec: number;
};

export const stage: Stage = {
  name: "video-generation",
  label: "영상 생성",
  async run({ jobId, workspaceDir, data, uploads, emit, job }) {
    const scenesData = data["scene-multishot"] as SceneMultishot | undefined;
    const styleData = data["style-framework"] as StyleFramework | undefined;
    const briefData = data["creative-brief"] as CreativeBrief | undefined;
    const keyframesData = data["keyframes"] as
      | { keyframes: Array<{ scene_id: string; url: string }> }
      | undefined;
    const musicData = data["music-analysis"] as
      | { recommended_scene_duration_sec?: number }
      | undefined;

    if (!scenesData || !styleData || !briefData || !keyframesData) {
      throw new Error(
        "선행 단계 데이터 누락 (scenes / style / brief / keyframes)"
      );
    }

    // 활성 cast로 시그니처 lookup 만듦
    const removed = readRemovedIdsLocal(job.cast_overrides);
    const activeCast = getActiveCast(briefData, removed);
    const castById = new Map<string, CastMember>();
    for (const c of activeCast) castById.set(c.id, c);

    // 사용자가 삭제한 키프레임 scene_id 목록
    const removedKeyframeSceneIds = readRemovedKeyframes(job.keyframe_overrides);
    const removedKfSet = new Set(removedKeyframeSceneIds);

    // scene 길이: 음악 분석 권장치 (5 또는 10), 없으면 10 fallback
    const sceneDurationSec: 5 | 10 =
      Number(musicData?.recommended_scene_duration_sec) === 5 ? 5 : 10;

    // Stage 07이 keyframe을 만들 때 각 scene의 keyframe_path를 scenes.json에 저장함.
    // reference-to-video 모드면 키프레임 없음 (Stage 07 skip됨) → 빈 Map.
    const enrichedScenes = readEnrichedScenes(workspaceDir);
    const keyframePathBy = new Map<string, string>();
    for (const s of enrichedScenes.scenes as Array<Scene & { keyframe_path?: string }>) {
      if (s.keyframe_path) keyframePathBy.set(s.id, s.keyframe_path);
    }

    // 삭제된 scene은 영상 생성 스킵 (비용 절감)
    const scenesToProcess = scenesData.scenes.filter(
      (s) => !removedKfSet.has(s.id)
    );
    const newSceneCount = scenesToProcess.length;
    const videoMode = getVideoMode(job.video_mode);
    const estimatedTotal = estimateVideoCost(newSceneCount * sceneDurationSec, videoMode);
    emit({
      type: "budget_estimate",
      new_scenes: newSceneCount,
      duration_sec_each: sceneDurationSec,
      video_mode: videoMode,
      estimated_cost_krw: estimatedTotal,
    });
    console.log(
      `[${jobId}] 영상 생성 예상 비용: ₩${estimatedTotal.toLocaleString()} (${newSceneCount} × ${sceneDurationSec}초, ${videoMode})`
    );

    // reference-to-video 모드일 때 필요한 cast/style 시트 로컬 경로 lookup
    const sheetsRecord = data["character-style-sheet"] as
      | {
          character_sheets?: Array<{ cast_id: string; path: string }>;
          style_sheet_path?: string;
        }
      | undefined;
    const castSheetPathById = new Map<string, string>();
    for (const s of sheetsRecord?.character_sheets ?? []) {
      castSheetPathById.set(s.cast_id, s.path);
    }
    const styleSheetPath = sheetsRecord?.style_sheet_path ?? null;

    const clipsDir = path.join(workspaceDir, "clips");
    fs.mkdirSync(clipsDir, { recursive: true });

    let completedCount = 0;
    const totalCount = scenesData.scenes.length;

    type Outcome =
      | { ok: true; clip: SceneClip }
      | { ok: false; scene_id: string; error: string };

    // ★ 병렬 영상 생성 (VIDEO_CONCURRENCY개씩 동시) — 가장 큰 속도 향상
    // 사용자가 삭제한 scene은 제외 (timeline에서 fallback 클립 사용)
    const outcomes = await mapLimit<Scene, Outcome>(
      scenesToProcess,
      VIDEO_CONCURRENCY,
      async (scene) => {
        const keyframePath = keyframePathBy.get(scene.id);
        // image-to-video는 키프레임 필수. reference-to-video는 선택사항.
        if (
          videoMode === "image-to-video" &&
          (!keyframePath || !fs.existsSync(keyframePath))
        ) {
          const msg = "키프레임 로컬 경로를 찾을 수 없습니다 (image-to-video 모드)";
          emit({ scene_id: scene.id, status: "failed", error: msg });
          return { ok: false, scene_id: scene.id, error: msg };
        }

        const clipPath = path.join(clipsDir, `${scene.id}.mp4`);
        let lastError: unknown = null;

        for (let attempt = 0; attempt <= RETRIES_PER_SCENE; attempt++) {
          try {
            emit({
              scene_id: scene.id,
              status: "uploading",
              attempt: attempt + 1,
            });

            // 등장 cast 시그니처 (prompt용)
            const sceneCastSignatures = (scene.cast_in_scene ?? [])
              .map((id) => castById.get(id)?.appearance_signature)
              .filter((s): s is string => Boolean(s));

            const enhancedPrompt = buildEnhancedPrompt({
              scene,
              style: styleData,
              castSignatures: sceneCastSignatures,
              moodboardCount: uploads.moodboard.paths.length,
            });

            let videoRes;
            if (videoMode === "reference-to-video") {
              // ★ multi-image reference: 캐릭터 시트들 + 스타일 시트 + (있으면) 키프레임 + 무드보드
              const hasKeyframe = keyframePath && fs.existsSync(keyframePath);
              const refLocalPaths = [
                ...((scene.cast_in_scene ?? [])
                  .map((id) => castSheetPathById.get(id))
                  .filter((p): p is string => Boolean(p))),
                ...(styleSheetPath ? [styleSheetPath] : []),
                ...(hasKeyframe ? [keyframePath as string] : []),
                ...uploads.moodboard.paths.slice(0, 2),
              ].slice(0, 9); // fal.ai 한도 안전선
              if (refLocalPaths.length === 0) {
                throw new Error("reference-to-video인데 참조 이미지가 하나도 없습니다");
              }

              const refUrls = await Promise.all(refLocalPaths.map(uploadImage));
              emit({
                scene_id: scene.id,
                status: "queued",
                ref_count: refUrls.length,
                mode: "reference-to-video",
              });
              videoRes = await generateVideoWithRefs({
                prompt: enhancedPrompt,
                referenceImageUrls: refUrls,
                duration: String(sceneDurationSec) as "5" | "10",
                resolution: "720p",
                aspect_ratio: aspectFor(styleData.aspect_ratio),
                onProgress: (status) =>
                  emit({
                    scene_id: scene.id,
                    status: "progress",
                    queue_status: status,
                  }),
              });
            } else {
              // 기본: image-to-video (단일 키프레임). 위 check로 keyframePath 보장됨.
              const imageUrl = await uploadImage(keyframePath as string);
              emit({
                scene_id: scene.id,
                status: "queued",
                image_url: imageUrl,
                mode: "image-to-video",
              });
              videoRes = await generateVideo({
                prompt: enhancedPrompt,
                imageUrl,
                duration: String(sceneDurationSec) as "5" | "10",
                resolution: "720p",
                aspect_ratio: aspectFor(styleData.aspect_ratio),
                onProgress: (status) =>
                  emit({
                    scene_id: scene.id,
                    status: "progress",
                    queue_status: status,
                  }),
              });
            }

            await downloadVideo(videoRes.video_url, clipPath);
            const cost = estimateVideoCost(sceneDurationSec, videoMode);
            completedCount += 1;
            emit({
              scene_id: scene.id,
              status: "succeeded",
              cost_krw: cost,
              clip_path: clipPath,
              completed: completedCount,
              total: totalCount,
            });
            return {
              ok: true,
              clip: {
                scene_id: scene.id,
                clip_path: clipPath,
                cost_krw: cost,
                duration_sec: sceneDurationSec,
              },
            };
          } catch (e) {
            lastError = e;
            const msg = e instanceof Error ? e.message : String(e);
            emit({
              scene_id: scene.id,
              status: "retry",
              error: msg,
              attempt: attempt + 1,
            });
            // transient (503/timeout/rate-limit)면 지수 백오프, 아니면 빠르게 다음 시도
            if (attempt < RETRIES_PER_SCENE) {
              const isTransient = isTransientError(e);
              const delay = isTransient
                ? Math.min(30_000, 2_000 * Math.pow(2, attempt)) // 2s, 4s, 8s, 16s (max 30s)
                : 500;
              await new Promise((r) => setTimeout(r, delay));
            }
          }
        }
        const msg =
          lastError instanceof Error ? lastError.message : String(lastError);
        emit({ scene_id: scene.id, status: "failed", error: msg });
        return { ok: false, scene_id: scene.id, error: msg };
      }
    );

    const clips: SceneClip[] = outcomes.flatMap((o) =>
      o.ok ? [o.clip] : []
    );
    const failed: Array<{ scene_id: string; error: string }> = outcomes.flatMap(
      (o) => (o.ok ? [] : [{ scene_id: o.scene_id, error: o.error }])
    );

    // scenes.json에 clip_path 병합
    const finalEnriched = {
      ...scenesData,
      scenes: scenesData.scenes.map((s) => {
        const c = clips.find((c) => c.scene_id === s.id);
        const prev = enrichedScenes.scenes.find(
          (e: { id: string }) => e.id === s.id
        ) as Scene & { keyframe_path?: string; keyframe_url?: string };
        const merged: Record<string, unknown> = { ...s, ...prev };
        if (c) {
          merged.clip_path = c.clip_path;
          merged.clip_duration = c.duration_sec;
        }
        return merged;
      }),
    };
    fs.writeFileSync(
      path.join(workspaceDir, "scenes.json"),
      JSON.stringify(finalEnriched, null, 2)
    );

    const totalCost = clips.reduce((acc, c) => acc + c.cost_krw, 0);

    if (clips.length === 0) {
      throw new Error(
        `모든 영상 생성이 실패했습니다 (${failed.length}건): ${failed
          .map((f) => `${f.scene_id}: ${f.error}`)
          .join(" | ")}`
      );
    }

    return {
      data: {
        succeeded: clips.map((c) => ({
          scene_id: c.scene_id,
          clip_path: c.clip_path,
          cost_krw: c.cost_krw,
          duration_sec: c.duration_sec,
        })),
        failed,
        moodboard_in_prompt: uploads.moodboard.paths.length > 0,
        total_cost_krw: totalCost,
      },
      cost_krw: totalCost,
    };
  },
};

function readEnrichedScenes(workspaceDir: string): {
  scenes: Array<Scene & { keyframe_path?: string; keyframe_url?: string }>;
  [k: string]: unknown;
} {
  const p = path.join(workspaceDir, "scenes.json");
  if (!fs.existsSync(p)) {
    throw new Error("scenes.json이 없습니다 (Stage 06/07 선행 필요)");
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function buildEnhancedPrompt(args: {
  scene: Scene;
  style: StyleFramework;
  castSignatures: string[];
  moodboardCount: number;
}): string {
  const base = args.scene.video_prompt ?? args.scene.scene_prompt ?? "";
  const castDesc =
    args.castSignatures.length > 0
      ? `Subjects (must look identical to keyframe and consistent across all scenes): ${args.castSignatures.join("; ")}.`
      : "";
  const prefix = realismPromptPrefix();
  const realismNeg = realismNegativeAddon();
  const combinedNeg = [args.style.negative_prompt, realismNeg]
    .filter(Boolean)
    .join(", ");
  return [
    prefix + base.trim(),
    castDesc,
    `Continuity: animate naturally forward from the input image. Preserve visual style (${args.style.visual_style}), lighting, and color tone.`,
    combinedNeg ? `Avoid: ${combinedNeg}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function aspectFor(ar: StyleFramework["aspect_ratio"]): "16:9" | "9:16" | "1:1" {
  if (ar === "9:16") return "9:16";
  if (ar === "1:1") return "1:1";
  return "16:9";
}

function readRemovedIdsLocal(castOverridesJson: string | null): string[] {
  if (!castOverridesJson) return [];
  try {
    const parsed = JSON.parse(castOverridesJson) as { removed_ids?: string[] };
    return Array.isArray(parsed.removed_ids) ? parsed.removed_ids : [];
  } catch {
    return [];
  }
}

function readRemovedKeyframes(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { removed_scene_ids?: string[] };
    return Array.isArray(parsed.removed_scene_ids)
      ? parsed.removed_scene_ids
      : [];
  } catch {
    return [];
  }
}
