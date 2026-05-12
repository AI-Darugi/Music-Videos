import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import { hostImage } from "@/lib/image-host";
import { startJob } from "@/lib/orchestrator";

export const runtime = "nodejs";

const SUNO_URL_RE = /^https?:\/\/(www\.)?suno\.com\/(song|s)\/[A-Za-z0-9-]+/;

const VideoModeEnum = z.enum(["image-to-video", "reference-to-video"]);

const JsonBodySchema = z.object({
  suno_url: z.string().regex(SUNO_URL_RE, "Suno URL 형식이 올바르지 않습니다"),
  user_lyrics: z.string().max(10_000).optional().nullable(),
  video_mode: VideoModeEnum.optional().nullable(),
});

const MAX_LYRICS = 10_000;
const MOODBOARD_MAX = 5;
const MOODBOARD_FILE_MAX = 10 * 1024 * 1024;
const MOODBOARD_TOTAL_MAX = 50 * 1024 * 1024;
const PROTAGONIST_MAX = 10 * 1024 * 1024;
const AUDIO_MAX = 80 * 1024 * 1024; // WAV 5분 ~50MB까지 여유
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".oga", ".webm", ".mp4", ".mpga", ".mpeg"]);

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  const db = getDb();
  const now = Date.now();
  const id = nanoid(10);

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "multipart 파싱 실패" }, { status: 400 });
    }

    // 입력 모드: mp3 직접 업로드, 또는 suno_url + (uploads)
    const sunoUrlRaw = (form.get("suno_url") as string | null)?.trim() ?? "";
    const userLyricsRaw = (form.get("user_lyrics") as string | null) ?? null;
    const protagonistConsent =
      (form.get("protagonist_consent") as string | null) === "true";

    const dir = path.join(process.cwd(), "workspace", id);
    fs.mkdirSync(dir, { recursive: true });

    // 1) 오디오 파일 (옵션, mp3/wav/m4a/flac/ogg/webm 등)
    let mp3Path: string | null = null;
    const audioFile = form.get("mp3");
    if (audioFile instanceof File && audioFile.size > 0) {
      if (audioFile.size > AUDIO_MAX) {
        return NextResponse.json(
          { error: `오디오 파일 ${Math.floor(AUDIO_MAX / 1024 / 1024)}MB 초과` },
          { status: 413 }
        );
      }
      const ext = pickAudioExt(audioFile);
      if (!ext) {
        return NextResponse.json(
          {
            error:
              "지원하지 않는 오디오 형식입니다 (mp3/wav/m4a/flac/ogg/webm 가능)",
          },
          { status: 400 }
        );
      }
      mp3Path = path.join(dir, `audio${ext}`);
      fs.writeFileSync(mp3Path, Buffer.from(await audioFile.arrayBuffer()));
    }

    // 2) suno_url (옵션)
    let sunoUrl: string | null = null;
    if (sunoUrlRaw.length > 0) {
      if (!SUNO_URL_RE.test(sunoUrlRaw)) {
        return NextResponse.json(
          { error: "Suno URL 형식이 올바르지 않습니다" },
          { status: 400 }
        );
      }
      sunoUrl = sunoUrlRaw;
    }

    if (!mp3Path && !sunoUrl) {
      return NextResponse.json(
        { error: "Suno URL 또는 mp3 파일 중 하나는 필수입니다" },
        { status: 400 }
      );
    }

    // 3) 무드보드 (옵션 0-5장)
    const moodboardEntries = form.getAll("moodboard");
    const moodboardFiles = moodboardEntries.filter(
      (f): f is File => f instanceof File && f.size > 0
    );
    if (moodboardFiles.length > MOODBOARD_MAX) {
      return NextResponse.json(
        { error: `무드보드는 최대 ${MOODBOARD_MAX}장입니다` },
        { status: 400 }
      );
    }
    let moodboardTotal = 0;
    for (const f of moodboardFiles) {
      if (!IMAGE_MIMES.has(f.type)) {
        return NextResponse.json(
          { error: `지원하지 않는 이미지 형식: ${f.type}` },
          { status: 400 }
        );
      }
      if (f.size > MOODBOARD_FILE_MAX) {
        return NextResponse.json(
          { error: `무드보드 이미지 1장당 10MB 이하` },
          { status: 413 }
        );
      }
      moodboardTotal += f.size;
    }
    if (moodboardTotal > MOODBOARD_TOTAL_MAX) {
      return NextResponse.json(
        { error: `무드보드 총합 50MB 초과` },
        { status: 413 }
      );
    }
    const uploadsDir = path.join(dir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const moodboardPaths: string[] = [];
    for (let i = 0; i < moodboardFiles.length; i++) {
      const f = moodboardFiles[i];
      const ext = guessExt(f.type, f.name) ?? ".png";
      const dest = path.join(uploadsDir, `moodboard-${i}${ext}`);
      fs.writeFileSync(dest, Buffer.from(await f.arrayBuffer()));
      moodboardPaths.push(dest);
    }

    // 4) 주인공 사진 (옵션 1장, consent 필수)
    const protagonistFile = form.get("protagonist");
    let protagonistPath: string | null = null;
    if (protagonistFile instanceof File && protagonistFile.size > 0) {
      if (!protagonistConsent) {
        return NextResponse.json(
          {
            error:
              "주인공 사진 업로드 시 '본인 사진임을 확인합니다' 동의가 필요합니다",
          },
          { status: 400 }
        );
      }
      if (!IMAGE_MIMES.has(protagonistFile.type)) {
        return NextResponse.json(
          { error: `주인공 사진은 jpg/png/webp만 가능합니다` },
          { status: 400 }
        );
      }
      if (protagonistFile.size > PROTAGONIST_MAX) {
        return NextResponse.json(
          { error: `주인공 사진 10MB 초과` },
          { status: 413 }
        );
      }
      const ext = guessExt(protagonistFile.type, protagonistFile.name) ?? ".png";
      protagonistPath = path.join(uploadsDir, `protagonist${ext}`);
      fs.writeFileSync(
        protagonistPath,
        Buffer.from(await protagonistFile.arrayBuffer())
      );
    }

    // 5) user_lyrics
    let userLyrics: string | null = null;
    if (userLyricsRaw && userLyricsRaw.trim().length > 0) {
      if (userLyricsRaw.length > MAX_LYRICS) {
        return NextResponse.json(
          { error: `가사는 최대 ${MAX_LYRICS}자입니다` },
          { status: 413 }
        );
      }
      userLyrics = userLyricsRaw;
    }

    // 5.5) video_mode 토글 (잡 단위)
    const videoModeRaw = (form.get("video_mode") as string | null) ?? null;
    let videoMode: string | null = null;
    if (
      videoModeRaw === "image-to-video" ||
      videoModeRaw === "reference-to-video"
    ) {
      videoMode = videoModeRaw;
    }

    // 6) 호스팅 URL 변환 (외부 API가 fetch할 수 있게)
    const moodboardUrls: string[] = [];
    for (const p of moodboardPaths) {
      moodboardUrls.push(await hostImage(p));
    }
    const protagonistUrl = protagonistPath ? await hostImage(protagonistPath) : null;

    db.prepare(
      `INSERT INTO jobs (
        id, suno_url, mp3_path, status,
        moodboard_paths, protagonist_path, moodboard_urls, protagonist_url, user_lyrics,
        video_mode,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      sunoUrl,
      mp3Path,
      moodboardPaths.length > 0 ? JSON.stringify(moodboardPaths) : null,
      protagonistPath,
      moodboardUrls.length > 0 ? JSON.stringify(moodboardUrls) : null,
      protagonistUrl,
      userLyrics,
      videoMode,
      now,
      now
    );
    startJob(id);
    return NextResponse.json({ id });
  }

  // JSON 모드 (uploads 없이 Suno URL만)
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }
  const parsed = JsonBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid" },
      { status: 400 }
    );
  }

  db.prepare(
    `INSERT INTO jobs (id, suno_url, status, user_lyrics, video_mode, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    id,
    parsed.data.suno_url,
    parsed.data.user_lyrics ?? null,
    parsed.data.video_mode ?? null,
    now,
    now
  );
  startJob(id);
  return NextResponse.json({ id });
}

function pickAudioExt(file: File): string | null {
  // 1차: 파일명 확장자
  const fromName = path.extname(file.name).toLowerCase();
  if (AUDIO_EXTS.has(fromName)) return fromName;
  // 2차: mime 타입으로 추정
  const mime = file.type.toLowerCase();
  if (mime === "audio/mpeg" || mime === "audio/mp3") return ".mp3";
  if (mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave") return ".wav";
  if (mime === "audio/mp4" || mime === "audio/m4a" || mime === "audio/x-m4a") return ".m4a";
  if (mime === "audio/flac" || mime === "audio/x-flac") return ".flac";
  if (mime === "audio/ogg" || mime === "audio/oga") return ".ogg";
  if (mime === "audio/webm") return ".webm";
  // 3차: audio/*면 .mp3로 fallback (Whisper가 어차피 헤더로 판단)
  if (mime.startsWith("audio/")) return ".mp3";
  return null;
}

function guessExt(mime: string, filename: string | null): string | null {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (filename) {
    const ext = path.extname(filename);
    if (ext) return ext;
  }
  return null;
}
