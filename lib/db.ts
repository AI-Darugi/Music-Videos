import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const WORKSPACE_DIR = path.join(process.cwd(), "workspace");
const DB_PATH = path.join(WORKSPACE_DIR, "jobs.db");

export type JobStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed";
export type StageStatus = "pending" | "running" | "completed" | "failed";

export type JobRow = {
  id: string;
  suno_url: string | null;
  mp3_path: string | null;
  mp3_url: string | null;
  status: JobStatus;
  current_stage: string | null;
  result_path: string | null;
  thumbnail_path: string | null;
  error: string | null;
  total_cost_krw: number;
  // 선택 입력 (uploads + lyrics)
  moodboard_paths: string | null; // JSON 배열
  protagonist_path: string | null;
  moodboard_urls: string | null; // JSON 배열 (외부 fetch 가능 URL)
  protagonist_url: string | null;
  user_lyrics: string | null;
  // multi-cast 지원
  paused_at_stage: string | null;
  cast_overrides: string | null; // JSON: { removed_ids: string[] }
  keyframe_overrides: string | null; // JSON: { removed_scene_ids: string[] }
  // 영상 모드 (잡 단위 토글)
  video_mode: string | null; // "image-to-video" | "reference-to-video"
  created_at: number;
  updated_at: number;
};

export type StageLogRow = {
  id: number;
  job_id: string;
  stage_name: string;
  status: StageStatus;
  started_at: number | null;
  completed_at: number | null;
  data_json: string | null;
  error: string | null;
  cost_krw: number;
};

const globalForDb = globalThis as unknown as { _aiMvDb?: Database.Database };

export function getDb(): Database.Database {
  if (globalForDb._aiMvDb) {
    // 캐시된 DB여도 ensureSchema는 멱등하게 매번 호출
    // (코드에 새 컬럼 추가하면 dev 서버 재시작 안 해도 즉시 반영)
    ensureSchema(globalForDb._aiMvDb);
    return globalForDb._aiMvDb;
  }

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  globalForDb._aiMvDb = db;
  return db;
}

function ensureSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      suno_url TEXT,
      mp3_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      current_stage TEXT,
      result_path TEXT,
      thumbnail_path TEXT,
      error TEXT,
      total_cost_krw INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      stage_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER,
      completed_at INTEGER,
      data_json TEXT,
      error TEXT,
      cost_krw INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_stage_logs_job ON stage_logs(job_id);
  `);

  // 멱등 ALTER — 매 getDb 호출마다 실행됨 (있으면 skip, 없으면 추가)
  ensureColumn(db, "jobs", "moodboard_paths", "TEXT");
  ensureColumn(db, "jobs", "protagonist_path", "TEXT");
  ensureColumn(db, "jobs", "moodboard_urls", "TEXT");
  ensureColumn(db, "jobs", "protagonist_url", "TEXT");
  ensureColumn(db, "jobs", "user_lyrics", "TEXT");
  ensureColumn(db, "jobs", "paused_at_stage", "TEXT");
  ensureColumn(db, "jobs", "cast_overrides", "TEXT");
  ensureColumn(db, "jobs", "keyframe_overrides", "TEXT");
  ensureColumn(db, "jobs", "video_mode", "TEXT");
  ensureColumn(db, "jobs", "mp3_url", "TEXT");
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string
) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function getJob(id: string): JobRow | undefined {
  return getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | JobRow
    | undefined;
}

export function getStageLogs(jobId: string): StageLogRow[] {
  return getDb()
    .prepare("SELECT * FROM stage_logs WHERE job_id = ? ORDER BY id ASC")
    .all(jobId) as StageLogRow[];
}

export type JobUploads = {
  moodboard: { paths: string[]; urls: string[] };
  protagonist: { path: string | null; url: string | null };
};

export function getJobUploads(job: JobRow): JobUploads {
  return {
    moodboard: {
      paths: safeJsonArray(job.moodboard_paths),
      urls: safeJsonArray(job.moodboard_urls),
    },
    protagonist: {
      path: job.protagonist_path,
      url: job.protagonist_url,
    },
  };
}

function safeJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
