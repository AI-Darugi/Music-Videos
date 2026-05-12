// fal.ai — Seedance Lite image-to-video.
// 종량제, $5부터 충전, ngrok 불필요 (fal.storage.upload로 직접 호스팅).
import { fal } from "@fal-ai/client";
import fs from "node:fs";
import path from "node:path";

let _configured = false;

function ensureConfigured() {
  if (_configured) return;
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY 환경변수가 없습니다");
  fal.config({ credentials: key });
  _configured = true;
}

// 영상 모드: image-to-video (단일 키프레임) | reference-to-video (multi-image ref, 일관성 ↑, 비쌈)
export type VideoMode = "image-to-video" | "reference-to-video";
/**
 * 영상 모드 결정 (잡 단위 override > env > default).
 * @param jobMode - jobs.video_mode 컬럼 값 (사용자가 잡 만들 때 선택)
 */
export function getVideoMode(jobMode?: string | null): VideoMode {
  if (jobMode === "reference-to-video") return "reference-to-video";
  if (jobMode === "image-to-video") return "image-to-video";
  const m = (process.env.FAL_VIDEO_MODE ?? "image-to-video").toLowerCase();
  return m === "reference-to-video" ? "reference-to-video" : "image-to-video";
}

export const FAL_VIDEO_MODEL =
  process.env.FAL_VIDEO_MODEL ?? "fal-ai/bytedance/seedance/v1/lite/image-to-video";

export const FAL_VIDEO_MODEL_REFERENCE =
  process.env.FAL_VIDEO_MODEL_REFERENCE ??
  "fal-ai/bytedance/seedance/v1/pro/reference-to-video";

// fal.ai Seedance Lite 추정 — 1초당 약 50~100원 (종량제, 첫 호출 후 보정)
const PRICE_PER_SEC_KRW = Number(process.env.FAL_PRICE_PER_SEC_KRW ?? "100");
// fal.ai Seedance Pro reference-to-video 추정 — Lite의 약 3배
const PRICE_PER_SEC_KRW_REFERENCE = Number(
  process.env.FAL_PRICE_PER_SEC_KRW_REFERENCE ?? "300"
);

export async function uploadImage(localPath: string): Promise<string> {
  ensureConfigured();
  if (!fs.existsSync(localPath)) {
    throw new Error(`이미지 파일이 없습니다: ${localPath}`);
  }
  const buffer = fs.readFileSync(localPath);
  const mime = mimeFromExt(localPath);
  const blob = new Blob([new Uint8Array(buffer)], { type: mime });
  return await fal.storage.upload(blob);
}

export type VideoDuration = "5" | "10";
export type VideoResolution = "480p" | "720p" | "1080p";
export type VideoAspect = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

export type GenerateVideoParams = {
  prompt: string;
  imageUrl: string;
  duration?: VideoDuration;
  resolution?: VideoResolution;
  aspect_ratio?: VideoAspect;
  seed?: number;
  onProgress?: (status: string) => void;
};

export type VideoResult = {
  video_url: string;
  request_id: string;
};

export async function generateVideo(
  params: GenerateVideoParams
): Promise<VideoResult> {
  ensureConfigured();
  const result = await fal.subscribe(FAL_VIDEO_MODEL, {
    input: {
      prompt: params.prompt,
      image_url: params.imageUrl,
      duration: params.duration ?? "10",
      resolution: params.resolution ?? "720p",
      aspect_ratio: params.aspect_ratio ?? "16:9",
      seed: params.seed,
    },
    pollInterval: 3000,
    logs: false,
    onQueueUpdate: (update: { status: string }) => {
      params.onProgress?.(update.status);
    },
  });

  // fal.ai Seedance 응답 구조: data.video.{url, content_type, file_name, file_size}
  const data = result.data as
    | { video?: { url?: string } }
    | undefined;
  const videoUrl = data?.video?.url;
  if (!videoUrl) {
    throw new Error(
      `fal.ai 응답에 video URL이 없습니다: ${JSON.stringify(result.data)}`
    );
  }
  return {
    video_url: videoUrl,
    request_id: result.requestId,
  };
}

export async function downloadVideo(
  videoUrl: string,
  destPath: string
): Promise<void> {
  const res = await fetch(videoUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`fal.ai 영상 다운로드 실패: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

export function estimateVideoCost(durationSec: number, mode?: VideoMode): number {
  const m = mode ?? getVideoMode();
  const pricePerSec =
    m === "reference-to-video" ? PRICE_PER_SEC_KRW_REFERENCE : PRICE_PER_SEC_KRW;
  return Math.round(durationSec * pricePerSec);
}

// ============ Reference-to-Video (multi-image refs) ============
export type GenerateVideoRefsParams = {
  prompt: string;
  referenceImageUrls: string[]; // multiple, uploaded via uploadImage()
  duration?: VideoDuration;
  resolution?: VideoResolution;
  aspect_ratio?: VideoAspect;
  seed?: number;
  onProgress?: (status: string) => void;
};

export async function generateVideoWithRefs(
  params: GenerateVideoRefsParams
): Promise<VideoResult> {
  ensureConfigured();
  const result = await fal.subscribe(FAL_VIDEO_MODEL_REFERENCE, {
    input: {
      prompt: params.prompt,
      // fal.ai Seedance Pro reference-to-video는 reference_image_urls 배열 받음.
      // 정확한 파라미터명은 fal docs 확인 후 조정 (image_urls일 가능성도)
      reference_image_urls: params.referenceImageUrls,
      duration: params.duration ?? "10",
      resolution: params.resolution ?? "720p",
      aspect_ratio: params.aspect_ratio ?? "16:9",
      seed: params.seed,
    },
    pollInterval: 3000,
    logs: false,
    onQueueUpdate: (update: { status: string }) => {
      params.onProgress?.(update.status);
    },
  });
  const data = result.data as { video?: { url?: string } } | undefined;
  const videoUrl = data?.video?.url;
  if (!videoUrl) {
    throw new Error(
      `fal.ai reference-to-video 응답에 video URL이 없습니다: ${JSON.stringify(result.data)}`
    );
  }
  return { video_url: videoUrl, request_id: result.requestId };
}

function mimeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
