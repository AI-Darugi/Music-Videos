import { spawn } from "node:child_process";

export type FfmpegOptions = {
  cwd?: string;
};

/**
 * ffmpeg를 실행하고 종료 대기. stderr는 캡처해서 에러 메시지에 포함.
 */
export function runFfmpeg(args: string[], options: FfmpegOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    proc.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "ffmpeg를 찾을 수 없습니다. 시스템에 ffmpeg를 설치하고 PATH에 추가하세요. (winget install ffmpeg 또는 brew install ffmpeg)"
          )
        );
      } else {
        reject(e);
      }
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).slice(-10).join("\n");
        reject(new Error(`ffmpeg 실패 (exit ${code}):\n${tail}`));
        return;
      }
      resolve();
    });
  });
}
