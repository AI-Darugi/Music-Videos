import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getDb } from "../db";
import { probeDuration } from "../ffprobe";
import type { Stage } from "../orchestrator";

const SUNO_URL_RE = /^https?:\/\/(www\.)?suno\.com\/(song|s)\/[A-Za-z0-9-]+/;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type ParsedMeta = {
  title: string | null;
  audio_url: string | null;
  lyrics: string | null;
  duration_hint: number | null;
};

export const stage: Stage = {
  name: "input-analysis",
  label: "입력 분석",
  async run({ job, jobId, workspaceDir }) {
    const audioPath = path.join(workspaceDir, "audio.mp3");

    if (job.mp3_path) {
      if (!fs.existsSync(job.mp3_path)) {
        throw new Error(`업로드된 오디오 파일이 없습니다: ${job.mp3_path}`);
      }
      // 업로드 모드: 이미 저장됨 (mp3/wav/m4a/flac/ogg/webm 등 어느 포맷이든).
      const duration = await probeDuration(job.mp3_path);
      const ext = path.extname(job.mp3_path).toLowerCase();
      return {
        data: {
          source: "upload",
          mp3_path: job.mp3_path,
          format: ext.replace(".", "") || "unknown",
          duration,
        },
      };
    }

    if (!job.suno_url) {
      throw new Error("Suno URL과 업로드된 mp3 둘 다 없습니다");
    }
    const parsed = z
      .string()
      .regex(SUNO_URL_RE, "Suno URL 형식이 올바르지 않습니다")
      .safeParse(job.suno_url);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? "URL 형식 오류");
    }

    const meta = await fetchSunoMeta(job.suno_url);
    if (!meta.audio_url) {
      throw new Error(
        "Suno 페이지에서 mp3 URL을 찾지 못했습니다. " +
          "곡이 private이거나 페이지 구조가 바뀐 것 같아요. " +
          "mp3 직접 업로드로 다시 시도해주세요."
      );
    }

    await downloadFile(meta.audio_url, audioPath);
    const duration = await probeDuration(audioPath);

    getDb()
      .prepare("UPDATE jobs SET mp3_path = ?, updated_at = ? WHERE id = ?")
      .run(audioPath, Date.now(), jobId);

    return {
      data: {
        source: "suno",
        suno_url: job.suno_url,
        title: meta.title,
        has_lyrics: Boolean(meta.lyrics?.trim()),
        lyrics_hint: meta.lyrics,
        mp3_path: audioPath,
        duration,
      },
    };
  },
};

async function fetchSunoMeta(url: string): Promise<ParsedMeta> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
    redirect: "follow",
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error("곡을 찾을 수 없습니다 (404)");
    if (res.status === 403)
      throw new Error("Suno가 접근을 차단했습니다 (403). public 공유 URL인지 확인하세요.");
    throw new Error(`Suno 페이지 요청 실패: HTTP ${res.status}`);
  }
  const html = await res.text();

  // 방법 A: og:audio + og:title meta tag
  const og = parseOgTags(html);

  // 방법 B: __NEXT_DATA__
  const nd = parseNextData(html);

  const audio_url = og.audio ?? nd.audio_url;
  const title = og.title ?? nd.title;
  const lyrics = nd.lyrics ?? null;
  const duration_hint = nd.duration ?? null;

  return { title, audio_url, lyrics, duration_hint };
}

function parseOgTags(html: string): {
  audio: string | null;
  title: string | null;
} {
  const audio = matchMeta(html, "og:audio");
  const title = matchMeta(html, "og:title");
  return { audio, title };
}

function matchMeta(html: string, property: string): string | null {
  // 양방향 매칭: <meta property="og:audio" content="..."> 또는 content가 먼저 오는 경우
  const re1 = new RegExp(
    `<meta[^>]*property=["']${escapeRegExp(property)}["'][^>]*content=["']([^"']+)["']`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${escapeRegExp(property)}["']`,
    "i"
  );
  return html.match(re1)?.[1] ?? html.match(re2)?.[1] ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseNextData(html: string): {
  audio_url: string | null;
  title: string | null;
  lyrics: string | null;
  duration: number | null;
} {
  const m = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return { audio_url: null, title: null, lyrics: null, duration: null };

  try {
    const json: unknown = JSON.parse(m[1]);
    // 알려진 경로들 — Suno HTML 구조가 자주 바뀜
    const candidates = [
      "props.pageProps.song",
      "props.pageProps.songData",
      "props.pageProps.clip",
      "props.pageProps.data.song",
      "props.pageProps.data.clip",
    ];
    for (const dotted of candidates) {
      const node = lookup(json, dotted);
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        const audio_url = pickString(obj, [
          "audio_url",
          "audioUrl",
          "mp3_url",
          "mp3Url",
          "stream_url",
        ]);
        const title = pickString(obj, ["title", "name"]);
        const lyrics = pickString(obj, ["lyrics", "prompt", "metadata.prompt"]);
        const duration = pickNumber(obj, ["duration", "duration_seconds"]);
        if (audio_url || title || lyrics) {
          return { audio_url, title, lyrics, duration };
        }
      }
    }
    return { audio_url: null, title: null, lyrics: null, duration: null };
  } catch {
    return { audio_url: null, title: null, lyrics: null, duration: null };
  }
}

function lookup(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur && typeof cur === "object" && key in (cur as object)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = lookup(obj, k);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = lookup(obj, k);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`mp3 다운로드 실패: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 1024) {
    throw new Error(`다운로드된 파일이 너무 작습니다 (${buf.byteLength}B)`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}
