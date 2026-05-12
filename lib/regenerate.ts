// 부분 재생성 헬퍼: 캐릭터 시트 1장 / 키프레임 1장만 재생성.
// stage_logs.data_json을 in-place 업데이트해서 다음 stage가 자동으로 새 이미지 사용.
import fs from "node:fs";
import path from "node:path";
import { getDb, getJob, type JobRow, type StageLogRow } from "./db";
import { generateImage } from "./image-gen";
import { hostImage } from "./image-host";
import { generateOneCharacterSheet } from "./stages/05-character-style-sheet";
import {
  getActiveCast,
  type CreativeBrief,
  type CastMember,
} from "./stages/04-creative-brief";
import type { StyleFramework } from "./stages/03-style-framework";
import type {
  Scene,
  SceneMultishot,
} from "./stages/06-scene-multishot";
import { realismPromptPrefix, realismNegativeAddon } from "./realism";

const MOODBOARD_REFS_FOR_CHARACTER = 1;
const MAX_TOTAL_REFS = 5;

type LatestData<T> = { data: T; logId: number } | null;

function loadLatest<T = unknown>(jobId: string, stageName: string): LatestData<T> {
  const log = getDb()
    .prepare(
      `SELECT * FROM stage_logs
       WHERE job_id = ? AND stage_name = ? AND status = 'completed'
       ORDER BY id DESC LIMIT 1`
    )
    .get(jobId, stageName) as StageLogRow | undefined;
  if (!log || !log.data_json) return null;
  try {
    return { data: JSON.parse(log.data_json) as T, logId: log.id };
  } catch {
    return null;
  }
}

function readUploads(job: JobRow): {
  protagonist: { path: string | null };
  moodboard: { paths: string[] };
} {
  let mood: string[] = [];
  if (job.moodboard_paths) {
    try {
      const arr = JSON.parse(job.moodboard_paths) as unknown;
      if (Array.isArray(arr))
        mood = arr.filter((x): x is string => typeof x === "string");
    } catch {}
  }
  return {
    protagonist: { path: job.protagonist_path },
    moodboard: { paths: mood },
  };
}

function readRemovedCastIds(job: JobRow): string[] {
  if (!job.cast_overrides) return [];
  try {
    const parsed = JSON.parse(job.cast_overrides) as { removed_ids?: string[] };
    return Array.isArray(parsed.removed_ids) ? parsed.removed_ids : [];
  } catch {
    return [];
  }
}

// ============ 캐릭터 시트 1장 재생성 ============
export async function regenerateOneCharacterSheet(args: {
  jobId: string;
  castId: string;
  promptAddition?: string;
}): Promise<{ url: string; cost_krw: number }> {
  const { jobId, castId, promptAddition } = args;
  const job = getJob(jobId);
  if (!job) throw new Error("job not found");

  const briefRec = loadLatest<CreativeBrief>(jobId, "creative-brief");
  const styleRec = loadLatest<StyleFramework>(jobId, "style-framework");
  const sheetsRec = loadLatest<Record<string, unknown>>(
    jobId,
    "character-style-sheet"
  );
  if (!briefRec || !styleRec || !sheetsRec) {
    throw new Error("선행 단계 데이터 누락 (brief/style/character-style-sheet)");
  }

  const activeCast = getActiveCast(briefRec.data, readRemovedCastIds(job));
  const member = activeCast.find((c) => c.id === castId);
  if (!member) throw new Error(`cast_id ${castId} 못 찾음 (삭제됐을 수 있음)`);

  // 스타일 메모를 personality에 임시 추가 (Claude의 텍스트가 들어가는 부분)
  const memberWithMemo: CastMember = promptAddition
    ? {
        ...member,
        appearance: `${member.appearance}\n\n[Style note]: ${promptAddition}`,
      }
    : member;

  const refsDir = path.join(process.cwd(), "workspace", jobId, "refs");
  fs.mkdirSync(refsDir, { recursive: true });

  const uploads = readUploads(job);
  const isLead = activeCast[0]?.id === castId;
  const result = await generateOneCharacterSheet({
    member: memberWithMemo,
    isLead,
    style: styleRec.data,
    refsDir,
    uploads,
    characterMoodRefs: uploads.moodboard.paths.slice(0, MOODBOARD_REFS_FOR_CHARACTER),
  });

  // stage_logs.data_json 갱신: 해당 cast_id 항목의 url/path만 교체
  const sheetsData = sheetsRec.data as {
    character_sheets?: Array<{
      cast_id: string;
      cast_role: string;
      path: string;
      url: string;
      source: string;
      policy_warning: string | null;
    }>;
    [k: string]: unknown;
  };
  if (Array.isArray(sheetsData.character_sheets)) {
    sheetsData.character_sheets = sheetsData.character_sheets.map((s) =>
      s.cast_id === castId
        ? {
            ...s,
            path: result.path,
            url: result.url,
            source: result.source,
            policy_warning: result.policy_warning,
          }
        : s
    );
    // lead 시트면 호환용 단일 키도 갱신
    if (isLead) {
      sheetsData.character_sheet_path = result.path;
      sheetsData.character_sheet_url = result.url;
    }
  }

  getDb()
    .prepare(`UPDATE stage_logs SET data_json = ?, cost_krw = cost_krw + ? WHERE id = ?`)
    .run(JSON.stringify(sheetsData), result.cost_krw, sheetsRec.logId);
  getDb()
    .prepare(`UPDATE jobs SET total_cost_krw = total_cost_krw + ?, updated_at = ? WHERE id = ?`)
    .run(result.cost_krw, Date.now(), jobId);

  return { url: result.url, cost_krw: result.cost_krw };
}

// ============ 키프레임 1장 재생성 ============
export async function regenerateOneKeyframe(args: {
  jobId: string;
  sceneId: string;
  promptAddition?: string;
}): Promise<{ url: string; cost_krw: number }> {
  const { jobId, sceneId, promptAddition } = args;
  const job = getJob(jobId);
  if (!job) throw new Error("job not found");

  const styleRec = loadLatest<StyleFramework>(jobId, "style-framework");
  const briefRec = loadLatest<CreativeBrief>(jobId, "creative-brief");
  const scenesRec = loadLatest<SceneMultishot>(jobId, "scene-multishot");
  const sheetsRec = loadLatest<Record<string, unknown>>(
    jobId,
    "character-style-sheet"
  );
  const keyframesRec = loadLatest<{
    keyframes?: Array<{ scene_id: string; url: string; cost_krw?: number }>;
    [k: string]: unknown;
  }>(jobId, "keyframes");
  if (!styleRec || !briefRec || !scenesRec || !sheetsRec || !keyframesRec) {
    throw new Error("선행 단계 데이터 누락");
  }

  // 디스크의 scenes.json (full 데이터)
  const workspaceDir = path.join(process.cwd(), "workspace", jobId);
  let fullScenes: SceneMultishot = scenesRec.data;
  const scenesPath = path.join(workspaceDir, "scenes.json");
  if (fs.existsSync(scenesPath)) {
    try {
      fullScenes = JSON.parse(fs.readFileSync(scenesPath, "utf-8"));
    } catch {}
  }
  const scene = fullScenes.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`scene ${sceneId} 못 찾음`);

  const uploads = readUploads(job);
  const activeCast = getActiveCast(briefRec.data, readRemovedCastIds(job));

  const sheetsData = sheetsRec.data as {
    character_sheets?: Array<{ cast_id: string; path: string }>;
    style_sheet_path?: string;
  };
  const castSheetsById = new Map<string, string>();
  for (const s of sheetsData.character_sheets ?? []) {
    if (activeCast.some((c) => c.id === s.cast_id))
      castSheetsById.set(s.cast_id, s.path);
  }

  const sceneCastIds = (scene as Scene).cast_in_scene ?? [];
  const castSheetPaths = sceneCastIds
    .map((id) => castSheetsById.get(id))
    .filter((p): p is string => Boolean(p));
  const sceneCastSignatures = sceneCastIds
    .map((id) => activeCast.find((c) => c.id === id)?.appearance_signature)
    .filter((s): s is string => Boolean(s));

  const refImages = [
    ...castSheetPaths,
    sheetsData.style_sheet_path,
    ...uploads.moodboard.paths.slice(0, 1),
  ]
    .filter((p): p is string => Boolean(p))
    .slice(0, MAX_TOTAL_REFS);

  const prefix = realismPromptPrefix();
  const realismNeg = realismNegativeAddon();
  const combinedNeg = [styleRec.data.negative_prompt, realismNeg]
    .filter(Boolean)
    .join(", ");

  const basePrompt =
    (scene as Scene).image_prompt ??
    (scene as Scene).scene_prompt ??
    `Cinematic opening frame: ${(scene as Scene).narrative_purpose}`;
  const memoLine = promptAddition ? `\n\n[Style note]: ${promptAddition}\n` : "";
  const castLock = sceneCastSignatures.length
    ? `\n\nSUBJECTS: ${sceneCastSignatures.join(" | ")}\n`
    : "";
  const refBinding =
    `\nREFERENCE BINDING: subjects must match the character sheet refs. Style must match the style sheet. Aspect ratio: ${styleRec.data.aspect_ratio}.` +
    (combinedNeg ? ` Avoid: ${combinedNeg}.` : "");
  const prompt = prefix + basePrompt + memoLine + castLock + refBinding;

  const keyframesDir = path.join(workspaceDir, "keyframes");
  fs.mkdirSync(keyframesDir, { recursive: true });
  const outputPath = path.join(keyframesDir, `${sceneId}.png`);

  const res = await generateImage({
    prompt,
    references: refImages,
    size: sizeFromAspect(styleRec.data.aspect_ratio),
    quality: "medium",
    outputPath,
  });
  const url = await hostImage(outputPath);

  // stage_logs.data_json 갱신: 해당 scene_id 항목의 url 교체
  const kfData = keyframesRec.data;
  if (Array.isArray(kfData.keyframes)) {
    kfData.keyframes = kfData.keyframes.map((k) =>
      k.scene_id === sceneId ? { ...k, url, cost_krw: res.cost_krw } : k
    );
  }
  getDb()
    .prepare(`UPDATE stage_logs SET data_json = ?, cost_krw = cost_krw + ? WHERE id = ?`)
    .run(JSON.stringify(kfData), res.cost_krw, keyframesRec.logId);
  getDb()
    .prepare(`UPDATE jobs SET total_cost_krw = total_cost_krw + ?, updated_at = ? WHERE id = ?`)
    .run(res.cost_krw, Date.now(), jobId);

  // scenes.json 디스크에도 keyframe_path 유지 (이미 기존 경로와 같음)

  return { url, cost_krw: res.cost_krw };
}

function sizeFromAspect(
  ar: StyleFramework["aspect_ratio"]
): "1024x1024" | "1792x1024" | "1024x1792" {
  if (ar === "16:9") return "1792x1024";
  if (ar === "9:16") return "1024x1792";
  return "1024x1024";
}
