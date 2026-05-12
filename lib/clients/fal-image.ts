// fal.ai — Flux Kontext Pro Max (이미지 생성, multi-image reference).
// 실사 photorealism 최강. multi-image input 지원으로 캐릭터/스타일 ref 처리 가능.
import { fal } from "@fal-ai/client";
import fs from "node:fs";
import path from "node:path";
import type { GenerateImageOptions, GenerateImageResult } from "./openai";

let _configured = false;

function ensureConfigured() {
  if (_configured) return;
  const key = process.env.FAL_KEY;
  if (!key) throw new Error("FAL_KEY 환경변수가 없습니다");
  fal.config({ credentials: key });
  _configured = true;
}

// 기본: multi-image용 Flux Kontext Max
// 단일 이미지/refs 없을 땐: Flux Pro 1.1 Ultra (txt2img)
const FLUX_MULTI_MODEL =
  process.env.FAL_FLUX_MULTI_MODEL ?? "fal-ai/flux-pro/kontext/max/multi";
const FLUX_TXT2IMG_MODEL =
  process.env.FAL_FLUX_TXT2IMG_MODEL ?? "fal-ai/flux-pro/v1.1-ultra";

// USD → KRW 환율
const USD_TO_KRW = 1380;
// Flux Pro Kontext Max ~ $0.07/image, Ultra ~ $0.06/image (추정, 첫 호출 후 보정)
const FLUX_USD_PER_IMAGE_MULTI = Number(
  process.env.FAL_FLUX_USD_PER_IMAGE_MULTI ?? "0.07"
);
const FLUX_USD_PER_IMAGE_TXT2IMG = Number(
  process.env.FAL_FLUX_USD_PER_IMAGE_TXT2IMG ?? "0.06"
);

async function uploadRef(localPath: string): Promise<string> {
  if (!fs.existsSync(localPath)) {
    throw new Error(`reference 파일이 없습니다: ${localPath}`);
  }
  const buf = fs.readFileSync(localPath);
  const mime = mimeFromExt(localPath);
  const blob = new Blob([new Uint8Array(buf)], { type: mime });
  return await fal.storage.upload(blob);
}

function mimeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function aspectFromSize(
  size: GenerateImageOptions["size"]
): "1:1" | "16:9" | "9:16" {
  if (size === "1792x1024") return "16:9";
  if (size === "1024x1792") return "9:16";
  return "1:1";
}

export async function generateImageFlux(
  opts: GenerateImageOptions
): Promise<GenerateImageResult> {
  ensureConfigured();
  const aspect = aspectFromSize(opts.size);
  const hasRefs = (opts.references ?? []).length > 0;

  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });

  let raw: unknown;
  let b64OrUrl: string | null = null;
  let cost_krw: number;

  if (hasRefs) {
    // Multi-image reference: Flux Kontext Max Multi
    const imageUrls = await Promise.all((opts.references ?? []).map(uploadRef));
    const result = await fal.subscribe(FLUX_MULTI_MODEL, {
      input: {
        prompt: opts.prompt,
        image_urls: imageUrls,
        aspect_ratio: aspect,
        guidance_scale: 3.5,
        num_inference_steps: 28,
        output_format: "png",
        safety_tolerance: "5",
      },
      pollInterval: 2000,
      logs: false,
    });
    raw = result;
    const data = result.data as
      | { images?: Array<{ url?: string }> }
      | undefined;
    b64OrUrl = data?.images?.[0]?.url ?? null;
    cost_krw = Math.round(FLUX_USD_PER_IMAGE_MULTI * USD_TO_KRW);
  } else {
    // 순수 txt2img: Flux Pro 1.1 Ultra
    const result = await fal.subscribe(FLUX_TXT2IMG_MODEL, {
      input: {
        prompt: opts.prompt,
        aspect_ratio: aspect,
        num_images: 1,
        output_format: "png",
        safety_tolerance: "5",
        enable_safety_checker: false,
      },
      pollInterval: 2000,
      logs: false,
    });
    raw = result;
    const data = result.data as
      | { images?: Array<{ url?: string }> }
      | undefined;
    b64OrUrl = data?.images?.[0]?.url ?? null;
    cost_krw = Math.round(FLUX_USD_PER_IMAGE_TXT2IMG * USD_TO_KRW);
  }

  if (!b64OrUrl) {
    throw new Error(
      `Flux 응답에 image URL이 없습니다: ${JSON.stringify((raw as { data?: unknown })?.data)}`
    );
  }

  // URL이면 다운로드
  const res = await fetch(b64OrUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Flux 이미지 다운로드 실패: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(opts.outputPath, buf);

  return { path: opts.outputPath, cost_krw, raw };
}
