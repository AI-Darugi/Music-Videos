import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "./ffmpeg";

// Whisper API 한도 25MB. 안전 마진 둬서 24MB.
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;

/**
 * 오디오 파일이 Whisper 한도(25MB) 안의 mp3면 그대로 반환.
 * 아니면 mp3로 변환해서 새 경로 반환 (워크스페이스 내부).
 *
 * 원본은 그대로 보존 — Stage 09(merge)에서 원곡 오디오로 그대로 사용.
 */
export async function ensureWhisperFriendly(
  audioPath: string,
  workspaceDir: string
): Promise<string> {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`오디오 파일이 없습니다: ${audioPath}`);
  }
  const ext = path.extname(audioPath).toLowerCase();
  const size = fs.statSync(audioPath).size;

  if (ext === ".mp3" && size <= WHISPER_MAX_BYTES) {
    return audioPath;
  }

  const out = path.join(workspaceDir, "audio-for-whisper.mp3");
  // 이미 변환된 게 있고 한도 안이면 재사용
  if (fs.existsSync(out) && fs.statSync(out).size <= WHISPER_MAX_BYTES) {
    return out;
  }

  // ffmpeg로 mp3 변환 (192kbps 스테레오)
  await runFfmpeg([
    "-i",
    audioPath,
    "-vn", // 비디오 스트림 제거
    "-ar",
    "44100",
    "-ac",
    "2",
    "-b:a",
    "192k",
    out,
  ]);

  const newSize = fs.statSync(out).size;
  if (newSize > WHISPER_MAX_BYTES) {
    // 그래도 큼 (매우 긴 트랙). 다운샘플로 더 줄이기.
    const out2 = path.join(workspaceDir, "audio-for-whisper-low.mp3");
    await runFfmpeg([
      "-i",
      audioPath,
      "-vn",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      "64k",
      out2,
    ]);
    return out2;
  }
  return out;
}
