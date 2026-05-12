import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "../ffmpeg";
import { getDb } from "../db";
import type { Stage } from "../orchestrator";
import type { SceneMultishot, TimelineEntry } from "./06-scene-multishot";
import type { WhisperSegment } from "../clients/openai";

type ClipMap = Map<string, { path: string; duration: number }>;

export const stage: Stage = {
  name: "merge",
  label: "병합 및 마무리",
  async run({ jobId, workspaceDir, data }) {
    const scenesData = data["scene-multishot"] as SceneMultishot | undefined;
    const videoData = data["video-generation"] as
      | { succeeded: Array<{ scene_id: string; clip_path: string; duration_sec: number }> }
      | undefined;
    const musicData = data["music-analysis"] as
      | { is_instrumental?: boolean; duration?: number; transcript_path?: string }
      | undefined;
    const inputData = data["input-analysis"] as
      | { mp3_path: string }
      | undefined;

    if (!scenesData) throw new Error("scenes 데이터 없음");
    if (!videoData) throw new Error("video-generation 데이터 없음");
    if (!inputData?.mp3_path) throw new Error("입력 mp3 경로 없음");

    const clipMap: ClipMap = new Map(
      videoData.succeeded.map((c) => [
        c.scene_id,
        { path: c.clip_path, duration: c.duration_sec },
      ])
    );
    if (clipMap.size === 0) {
      throw new Error("병합할 영상 클립이 하나도 없습니다");
    }

    // 1) 타임라인을 따라 각 엔트리에 맞는 trimmed segment를 생성
    const trimmedDir = path.join(workspaceDir, "trimmed");
    fs.mkdirSync(trimmedDir, { recursive: true });
    const segments: string[] = [];
    let idx = 0;
    for (const entry of scenesData.timeline) {
      const clip = clipMap.get(entry.scene_id);
      if (!clip) {
        // 해당 scene 영상이 실패했을 수 있음. 일단 다른 클립이 있으면 그걸로 fallback.
        const fallback = pickAnyClip(clipMap);
        if (!fallback) throw new Error(`clip 없음: ${entry.scene_id}`);
        await trimSegment(
          fallback.path,
          entry.end_sec - entry.start_sec,
          path.join(trimmedDir, `seg-${idx}.mp4`)
        );
      } else {
        await trimSegment(
          clip.path,
          entry.end_sec - entry.start_sec,
          path.join(trimmedDir, `seg-${idx}.mp4`)
        );
      }
      segments.push(path.join(trimmedDir, `seg-${idx}.mp4`));
      idx++;
    }

    // 2) concat
    const listFile = path.join(workspaceDir, "concat.txt");
    fs.writeFileSync(
      listFile,
      segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
    );
    const silentMerged = path.join(workspaceDir, "silent-merged.mp4");
    await runFfmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-an",
      silentMerged,
    ]);

    // 3) 원곡 오디오 입히기
    const withAudio = path.join(workspaceDir, "with-audio.mp4");
    await runFfmpeg([
      "-i",
      silentMerged,
      "-i",
      inputData.mp3_path,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      withAudio,
    ]);

    // 4) 자막 burn-in (instrumental이 아니고 transcript가 있을 때)
    let finalMp4 = withAudio;
    let subtitleBurned = false;
    let subtitleLines = 0;
    if (!musicData?.is_instrumental && musicData?.transcript_path) {
      try {
        const srtPath = path.join(workspaceDir, "subtitle.srt");
        subtitleLines = writeSrtFromTranscript(
          musicData.transcript_path,
          srtPath
        );
        if (subtitleLines > 0) {
          const subbed = path.join(workspaceDir, "final.mp4");
          // ffmpeg subtitles filter는 경로의 콜론/백슬래시 이슈 있음. 작업 디렉터리로 cwd 변경하는 게 안전.
          const srtRel = path.basename(srtPath);
          await runFfmpeg(
            [
              "-i",
              withAudio,
              "-vf",
              `subtitles=${escapeForFilter(srtRel)}`,
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-crf",
              "23",
              "-c:a",
              "copy",
              subbed,
            ],
            { cwd: workspaceDir }
          );
          finalMp4 = subbed;
          subtitleBurned = true;
        }
      } catch (e) {
        // 자막 실패해도 음악+영상은 살리기
        console.warn(`자막 burn-in 실패: ${(e as Error).message}`);
      }
    }

    // 5) public/results/ 로 복사 + 썸네일
    const resultsDir = path.join(process.cwd(), "public", "results");
    fs.mkdirSync(resultsDir, { recursive: true });
    const publicMp4 = path.join(resultsDir, `${jobId}.mp4`);
    fs.copyFileSync(finalMp4, publicMp4);

    const thumbnailPath = path.join(resultsDir, `${jobId}.jpg`);
    try {
      await runFfmpeg([
        "-ss",
        "1",
        "-i",
        publicMp4,
        "-vframes",
        "1",
        "-q:v",
        "3",
        thumbnailPath,
      ]);
    } catch (e) {
      console.warn(`썸네일 생성 실패: ${(e as Error).message}`);
    }

    const resultPath = `/results/${jobId}.mp4`;
    const thumbPath = fs.existsSync(thumbnailPath)
      ? `/results/${jobId}.jpg`
      : null;

    getDb()
      .prepare(
        "UPDATE jobs SET result_path = ?, thumbnail_path = ?, updated_at = ? WHERE id = ?"
      )
      .run(resultPath, thumbPath, Date.now(), jobId);

    return {
      data: {
        result_path: resultPath,
        thumbnail_path: thumbPath,
        subtitle_burned: subtitleBurned,
        subtitle_lines: subtitleLines,
        segments_count: segments.length,
      },
      cost_krw: 0,
    };
  },
};

async function trimSegment(
  src: string,
  durationSec: number,
  dest: string
): Promise<void> {
  // re-encode로 안전하게 (코덱 통일)
  await runFfmpeg([
    "-i",
    src,
    "-t",
    durationSec.toFixed(2),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-an",
    dest,
  ]);
}

function pickAnyClip(clipMap: ClipMap): { path: string; duration: number } | null {
  const it = clipMap.values().next();
  return it.done ? null : it.value;
}

function writeSrtFromTranscript(transcriptPath: string, destPath: string): number {
  // 사용자 편집본 (transcript-user.json) 우선 사용
  const userPath = path.join(
    path.dirname(transcriptPath),
    "transcript-user.json"
  );
  let segments: WhisperSegment[] = [];
  let source: "user" | "auto" = "auto";
  if (fs.existsSync(userPath)) {
    try {
      const userRaw = JSON.parse(fs.readFileSync(userPath, "utf-8")) as {
        segments?: WhisperSegment[];
      };
      if (Array.isArray(userRaw.segments) && userRaw.segments.length > 0) {
        segments = userRaw.segments;
        source = "user";
        console.log(
          `[자막] 사용자 편집본 ${segments.length}개 사용 (${userPath})`
        );
      }
    } catch {
      // 손상 시 자동본 사용
    }
  }
  if (segments.length === 0) {
    const raw = JSON.parse(fs.readFileSync(transcriptPath, "utf-8")) as {
      segments?: WhisperSegment[];
    };
    segments = raw.segments ?? [];
  }
  if (segments.length === 0) return 0;
  void source;

  // Whisper raw에서 word-level 타임스탬프 가져와 vocal onset 정확히 찾기.
  // (Stage 02가 transcript-whisper.json에 raw 저장함)
  const whisperRawPath = path.join(
    path.dirname(transcriptPath),
    "transcript-whisper.json"
  );
  const vocalOnset = readFirstVocalOnset(whisperRawPath);

  // 자막 sync 보정:
  // 1) offset — Whisper가 보통 0.3-0.5초 늦게 잡아서 미리 표시
  // 2) vocal_onset_floor — 실제 노래 시작 전엔 첫 자막 등장 X
  // 3) persist — 각 자막이 "다음 자막 시작 직전까지" 보이게 (사이 빈 시간 제거)
  const offset = Number(process.env.SUBTITLE_OFFSET_SEC ?? "-0.4");
  const gap = 0.05;
  // 인트로 동안 자막 안 보이게: 첫 자막 시작은 vocal onset (또는 사용자가 정한 값) 이후
  const introDelay = Number(
    process.env.SUBTITLE_INTRO_DELAY_SEC ?? String(vocalOnset ?? 0)
  );
  // vocal onset 직전 0.3초까지는 자막 미리 띄워도 OK (readability)
  const firstStartFloor = Math.max(0, introDelay - 0.3);

  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const next = segments[i + 1];

    // 각 segment의 정확한 시작: words 있으면 첫 word.start, 없으면 segment.start
    const segStart = seg.words?.[0]?.start ?? seg.start;
    const segEnd =
      seg.words && seg.words.length > 0
        ? seg.words[seg.words.length - 1].end
        : seg.end;

    let start = Math.max(0, segStart + offset);
    // 첫 자막은 vocal onset 이전엔 표시 안 함
    if (i === 0) start = Math.max(start, firstStartFloor);

    const nextSegStart = next ? next.words?.[0]?.start ?? next.start : segEnd + 2;
    const nextStart = next ? Math.max(0, nextSegStart + offset) : segEnd + 2;
    const naturalEnd = Math.max(start + 0.3, segEnd + offset);
    const end = Math.max(start + 0.3, Math.min(naturalEnd + 2, nextStart - gap));

    lines.push(String(i + 1));
    lines.push(`${srtTime(start)} --> ${srtTime(end)}`);
    lines.push(seg.text.trim());
    lines.push("");
  }
  fs.writeFileSync(destPath, lines.join("\n"), "utf-8");
  return segments.length;
}

/**
 * Whisper raw transcript에서 첫 vocal onset(첫 단어 시작 시간) 추출.
 * 인트로 동안 자막이 미리 뜨는 문제 해결용 floor.
 */
function readFirstVocalOnset(whisperRawPath: string): number | null {
  if (!fs.existsSync(whisperRawPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(whisperRawPath, "utf-8")) as {
      segments?: Array<{
        start?: number;
        words?: Array<{ start?: number }>;
      }>;
    };
    const segs = raw.segments ?? [];
    for (const s of segs) {
      const firstWord = s.words?.[0]?.start;
      if (typeof firstWord === "number" && firstWord > 0) return firstWord;
      if (typeof s.start === "number" && s.start > 0) return s.start;
    }
    return null;
  } catch {
    return null;
  }
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const hh = Math.floor(ms / 3_600_000)
    .toString()
    .padStart(2, "0");
  const mm = Math.floor((ms % 3_600_000) / 60_000)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor((ms % 60_000) / 1000)
    .toString()
    .padStart(2, "0");
  const mss = (ms % 1000).toString().padStart(3, "0");
  return `${hh}:${mm}:${ss},${mss}`;
}

function escapeForFilter(s: string): string {
  // ffmpeg subtitles 필터의 콜론/특수문자 이스케이프
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

