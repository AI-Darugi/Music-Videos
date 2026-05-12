// 이미지 호스팅 헬퍼: 로컬 파일을 BytePlus/외부 API가 fetch할 수 있는 URL로 변환.
//
// IMAGE_HOST_MODE 환경변수로 동작 모드 선택:
//   - "data_uri": base64 data URI (외부 호스팅 없음, 단 큰 파일은 prompt 토큰 폭증)
//   - "public":  public/hosted/ 로 복사 후 NEXT_PUBLIC_BASE_URL로 접근
//   - "blob":    Vercel Blob 등 외부 (미구현)
import fs from "node:fs";
import path from "node:path";

export type HostMode = "data_uri" | "public" | "blob";

export function getHostMode(): HostMode {
  const m = (process.env.IMAGE_HOST_MODE ?? "data_uri").toLowerCase();
  if (m === "data_uri" || m === "public" || m === "blob") return m;
  throw new Error(`알 수 없는 IMAGE_HOST_MODE: ${m}`);
}

/**
 * 로컬 이미지 파일을 외부 API가 fetch 가능한 URL로 변환.
 * @returns 외부에서 접근 가능한 URL (data: scheme 또는 http(s):)
 */
export async function hostImage(localPath: string): Promise<string> {
  const mode = getHostMode();
  if (!fs.existsSync(localPath)) {
    throw new Error(`이미지 파일이 없습니다: ${localPath}`);
  }
  switch (mode) {
    case "data_uri":
      return toDataUri(localPath);
    case "public":
      return await toPublicUrl(localPath);
    case "blob":
      throw new Error(
        "IMAGE_HOST_MODE=blob은 아직 미구현입니다. data_uri 또는 public을 사용하세요."
      );
  }
}

function toDataUri(localPath: string): string {
  const buf = fs.readFileSync(localPath);
  const mime = mimeFromExt(localPath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function toPublicUrl(localPath: string): Promise<string> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "IMAGE_HOST_MODE=public이면 NEXT_PUBLIC_BASE_URL 환경변수가 필요합니다"
    );
  }
  const hostedDir = path.join(process.cwd(), "public", "hosted");
  fs.mkdirSync(hostedDir, { recursive: true });
  const ext = path.extname(localPath) || ".png";
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
  const dest = path.join(hostedDir, name);
  fs.copyFileSync(localPath, dest);
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/hosted/${name}`;
}

function mimeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}
