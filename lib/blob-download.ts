// Vercel Blob에 올라간 mp3/이미지를 로컬 workspace로 가져와서
// 기존 stage 파이프라인(local path 기반)이 그대로 돌도록 한다.
//
// 호출 시점: orchestrator.runJob 시작 직후 (stages 돌기 전).
// 이미 로컬 path가 있으면 skip.
import fs from "node:fs";
import path from "node:path";
import { getDb, getJob } from "./db";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function extFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).toLowerCase();
    if (ext) return ext;
  } catch {
    // ignore
  }
  return fallback;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`다운로드 실패 (HTTP ${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 32) {
    throw new Error(`다운로드된 파일이 너무 작습니다 (${buf.byteLength}B): ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

function parseUrlArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * mp3_url / moodboard_urls / protagonist_url 가 있고 아직 로컬 경로가 비어있으면
 * workspace/{id}/uploads/ 아래로 받아와서 DB에 path를 기록한다.
 *
 * - 멱등: 이미 path가 채워져 있고 파일이 존재하면 skip.
 * - 부분 실패: mp3 다운로드 실패는 throw (Stage 01이 어차피 죽음).
 *   이미지 다운로드 실패는 throw해서 사용자가 빨리 알 수 있게 함.
 */
export async function ensureUploadFilesLocal(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);

  const workspaceDir = path.join(process.cwd(), "workspace", jobId);
  const uploadsDir = path.join(workspaceDir, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = getDb();

  // 1) mp3
  if (job.mp3_url && (!job.mp3_path || !fs.existsSync(job.mp3_path))) {
    const ext = extFromUrl(job.mp3_url, ".mp3");
    const dest = path.join(workspaceDir, `audio${ext}`);
    await download(job.mp3_url, dest);
    db.prepare("UPDATE jobs SET mp3_path = ?, updated_at = ? WHERE id = ?").run(
      dest,
      Date.now(),
      jobId
    );
  }

  // 2) moodboard
  const moodboardUrls = parseUrlArray(job.moodboard_urls);
  const existingMoodPaths = parseUrlArray(job.moodboard_paths);
  const needMoodDownload =
    moodboardUrls.length > 0 &&
    (existingMoodPaths.length !== moodboardUrls.length ||
      existingMoodPaths.some((p) => !fs.existsSync(p)));

  if (needMoodDownload) {
    const paths: string[] = [];
    for (let i = 0; i < moodboardUrls.length; i++) {
      const url = moodboardUrls[i];
      const ext = extFromUrl(url, ".png");
      const dest = path.join(uploadsDir, `moodboard-${i}${ext}`);
      await download(url, dest);
      paths.push(dest);
    }
    db.prepare(
      "UPDATE jobs SET moodboard_paths = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(paths), Date.now(), jobId);
  }

  // 3) protagonist
  if (
    job.protagonist_url &&
    (!job.protagonist_path || !fs.existsSync(job.protagonist_path))
  ) {
    const ext = extFromUrl(job.protagonist_url, ".png");
    const dest = path.join(uploadsDir, `protagonist${ext}`);
    await download(job.protagonist_url, dest);
    db.prepare(
      "UPDATE jobs SET protagonist_path = ?, updated_at = ? WHERE id = ?"
    ).run(dest, Date.now(), jobId);
  }
}
