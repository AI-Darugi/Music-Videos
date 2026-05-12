import { spawn } from "node:child_process";

/**
 * ffprobe로 미디어 파일의 길이(초)를 측정.
 * 시스템 PATH에 ffprobe가 있어야 함. 없으면 에러.
 */
export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (b: Buffer) => (out += b.toString()));
    proc.stderr.on("data", (b: Buffer) => (err += b.toString()));
    proc.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "ffprobe를 찾을 수 없습니다. 시스템에 ffmpeg를 설치하고 PATH에 추가하세요."
          )
        );
      } else {
        reject(e);
      }
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe 실패 (exit ${code}): ${err.trim()}`));
        return;
      }
      const seconds = parseFloat(out.trim());
      if (!Number.isFinite(seconds)) {
        reject(new Error(`ffprobe duration 파싱 실패: '${out.trim()}'`));
        return;
      }
      resolve(seconds);
    });
  });
}
