import fs from "node:fs";
import path from "node:path";
import {
  getDb,
  getJob,
  getJobUploads,
  type JobRow,
  type JobUploads,
  type StageLogRow,
} from "./db";
import { publish } from "./events";
import { stages, stageIndex } from "./stages";
import { ensureUploadFilesLocal } from "./blob-download";

// 자동 진행 (각 review 건너뜀)
const SKIP_STORY_REVIEW = process.env.SKIP_STORY_REVIEW === "true";
const SKIP_CAST_REVIEW = process.env.SKIP_CAST_REVIEW === "true";
const SKIP_SCENES_REVIEW = process.env.SKIP_SCENES_REVIEW === "true";
const SKIP_KEYFRAME_REVIEW = process.env.SKIP_KEYFRAME_REVIEW === "true";
const PAUSE_AFTER_BRIEF = "creative-brief";
const PAUSE_AFTER_CAST = "character-style-sheet";
const PAUSE_AFTER_SCENES = "scene-multishot";
const PAUSE_AFTER_KEYFRAMES = "keyframes";

export type StageContext = {
  jobId: string;
  job: JobRow;
  workspaceDir: string;
  uploads: JobUploads;
  userLyrics: string | null;
  data: Record<string, unknown>;
  emit: (data: unknown) => void;
};

export type StageResult = {
  data?: unknown;
  cost_krw?: number;
};

export type Stage = {
  name: string;
  label: string;
  run: (ctx: StageContext) => Promise<StageResult>;
};

const globalForRunner = globalThis as unknown as {
  _aiMvRunning?: Set<string>;
};

function isRunning(jobId: string) {
  if (!globalForRunner._aiMvRunning) globalForRunner._aiMvRunning = new Set();
  return globalForRunner._aiMvRunning.has(jobId);
}

function markRunning(jobId: string) {
  if (!globalForRunner._aiMvRunning) globalForRunner._aiMvRunning = new Set();
  globalForRunner._aiMvRunning.add(jobId);
}

function markStopped(jobId: string) {
  globalForRunner._aiMvRunning?.delete(jobId);
}

export function startJob(jobId: string, fromStage?: string): void {
  if (isRunning(jobId)) return;
  markRunning(jobId);
  void runJob(jobId, fromStage).finally(() => markStopped(jobId));
}

async function runJob(jobId: string, fromStage?: string): Promise<void> {
  const db = getDb();
  let job = getJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);

  const workspaceDir = path.join(process.cwd(), "workspace", jobId);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const startIdx = fromStage ? stageIndex(fromStage) : 0;
  if (startIdx < 0) {
    throw new Error(`unknown stage: ${fromStage}`);
  }

  db.prepare(
    "UPDATE jobs SET status = ?, error = NULL, updated_at = ? WHERE id = ?"
  ).run("running", Date.now(), jobId);

  // Vercel Blob 등 외부에 올라간 업로드 파일을 로컬 workspace로 가져온다.
  // (mp3_url / moodboard_urls / protagonist_url → mp3_path / moodboard_paths / protagonist_path)
  // 클라이언트 직접 업로드 흐름을 쓰면 jobs API는 URL만 받고, 실제 파일은 여기서 받아온다.
  try {
    await ensureUploadFilesLocal(jobId);
    // path 컬럼들이 갱신됐을 수 있으니 재조회
    const refreshed = getJob(jobId);
    if (refreshed) job = refreshed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?"
    ).run("failed", `업로드 파일 다운로드 실패: ${message}`, Date.now(), jobId);
    publish({ type: "job_failed", jobId, error: message });
    return;
  }

  // Restore prior stage data into context (for resume / regenerate)
  // job 변수는 위에서 refresh됐을 수 있음
  const ctxJob = job;
  const ctx: StageContext = {
    jobId,
    job: ctxJob,
    workspaceDir,
    uploads: getJobUploads(ctxJob),
    userLyrics: ctxJob.user_lyrics ?? null,
    data: {},
    emit: () => {},
  };
  const priorLogs = db
    .prepare(
      "SELECT * FROM stage_logs WHERE job_id = ? AND status = 'completed' ORDER BY id ASC"
    )
    .all(jobId) as StageLogRow[];
  for (const log of priorLogs) {
    if (log.data_json) {
      try {
        ctx.data[log.stage_name] = JSON.parse(log.data_json);
      } catch {
        // skip malformed
      }
    }
  }

  for (let i = startIdx; i < stages.length; i++) {
    const stage = stages[i];
    const startedAt = Date.now();

    const insert = db.prepare(
      `INSERT INTO stage_logs (job_id, stage_name, status, started_at)
       VALUES (?, ?, 'running', ?)`
    );
    const info = insert.run(jobId, stage.name, startedAt);
    const logId = Number(info.lastInsertRowid);

    db.prepare(
      "UPDATE jobs SET current_stage = ?, updated_at = ? WHERE id = ?"
    ).run(stage.name, Date.now(), jobId);

    publish({ type: "stage_started", jobId, stage: stage.name });

    ctx.emit = (data) =>
      publish({ type: "stage_progress", jobId, stage: stage.name, data });

    try {
      const result = await stage.run(ctx);
      const cost = result.cost_krw ?? 0;
      ctx.data[stage.name] = result.data ?? null;

      db.prepare(
        `UPDATE stage_logs
         SET status = 'completed', completed_at = ?, data_json = ?, cost_krw = ?
         WHERE id = ?`
      ).run(Date.now(), JSON.stringify(result.data ?? null), cost, logId);

      db.prepare(
        `UPDATE jobs SET total_cost_krw = total_cost_krw + ?, updated_at = ? WHERE id = ?`
      ).run(cost, Date.now(), jobId);

      publish({
        type: "stage_completed",
        jobId,
        stage: stage.name,
        data: result.data ?? null,
        cost_krw: cost,
      });

      // ★ Story review pause (Stage 04 brief 후): 컨셉/cast/세팅 확인
      if (stage.name === PAUSE_AFTER_BRIEF && !SKIP_STORY_REVIEW) {
        db.prepare(
          "UPDATE jobs SET status = 'paused', paused_at_stage = ?, current_stage = NULL, updated_at = ? WHERE id = ?"
        ).run(stage.name, Date.now(), jobId);
        publish({
          type: "job_paused",
          jobId,
          stage: stage.name,
          reason: "story_review",
        });
        return;
      }

      // ★ Scenes review pause (Stage 06 후): 30개 scene 흐름 확인
      if (stage.name === PAUSE_AFTER_SCENES && !SKIP_SCENES_REVIEW) {
        db.prepare(
          "UPDATE jobs SET status = 'paused', paused_at_stage = ?, current_stage = NULL, updated_at = ? WHERE id = ?"
        ).run(stage.name, Date.now(), jobId);
        publish({
          type: "job_paused",
          jobId,
          stage: stage.name,
          reason: "scenes_review",
        });
        return;
      }

      // ★ Cast review pause (Stage 05 후): cast 1명 이상일 때
      if (
        stage.name === PAUSE_AFTER_CAST &&
        !SKIP_CAST_REVIEW &&
        hasCastForReview(result.data)
      ) {
        db.prepare(
          "UPDATE jobs SET status = 'paused', paused_at_stage = ?, current_stage = NULL, updated_at = ? WHERE id = ?"
        ).run(stage.name, Date.now(), jobId);
        publish({
          type: "job_paused",
          jobId,
          stage: stage.name,
          reason: "cast_review",
        });
        return;
      }

      // ★ Keyframe review pause (Stage 07 후): 키프레임 1장 이상일 때
      if (
        stage.name === PAUSE_AFTER_KEYFRAMES &&
        !SKIP_KEYFRAME_REVIEW &&
        hasKeyframesForReview(result.data)
      ) {
        db.prepare(
          "UPDATE jobs SET status = 'paused', paused_at_stage = ?, current_stage = NULL, updated_at = ? WHERE id = ?"
        ).run(stage.name, Date.now(), jobId);
        publish({
          type: "job_paused",
          jobId,
          stage: stage.name,
          reason: "keyframe_review",
        });
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(
        `UPDATE stage_logs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`
      ).run(Date.now(), message, logId);
      db.prepare(
        "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?"
      ).run("failed", message, Date.now(), jobId);
      publish({
        type: "stage_failed",
        jobId,
        stage: stage.name,
        error: message,
      });
      publish({ type: "job_failed", jobId, error: message });
      return;
    }
  }

  const final = getJob(jobId);
  db.prepare(
    "UPDATE jobs SET status = ?, current_stage = NULL, paused_at_stage = NULL, updated_at = ? WHERE id = ?"
  ).run("completed", Date.now(), jobId);
  publish({
    type: "job_completed",
    jobId,
    result_path: final?.result_path ?? "",
  });
}

function hasCastForReview(stageData: unknown): boolean {
  if (!stageData || typeof stageData !== "object") return false;
  const d = stageData as { character_sheets?: unknown[]; cast_count?: number };
  if (Array.isArray(d.character_sheets) && d.character_sheets.length > 0) return true;
  if (typeof d.cast_count === "number" && d.cast_count > 0) return true;
  return false;
}

function hasKeyframesForReview(stageData: unknown): boolean {
  if (!stageData || typeof stageData !== "object") return false;
  const d = stageData as { keyframes?: unknown[] };
  return Array.isArray(d.keyframes) && d.keyframes.length > 0;
}
