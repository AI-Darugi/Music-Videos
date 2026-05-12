// 이미지 생성 라우터 — env(IMAGE_MODEL)에 따라 gpt-image-2 ↔ Flux Kontext 라우팅.
// 사용자가 잡마다 결과 비교 가능 (env 바꾸고 dev 재시작).
import { generateImage as generateImageOpenAI } from "./clients/openai";
import { generateImageFlux } from "./clients/fal-image";
import type {
  GenerateImageOptions,
  GenerateImageResult,
} from "./clients/openai";

export type ImageBackend = "gpt-image-2" | "flux-kontext";

export function getActiveImageBackend(): ImageBackend {
  const m = (process.env.IMAGE_MODEL ?? "gpt-image-2").toLowerCase();
  if (m === "flux" || m === "flux-kontext" || m === "flux-pro" || m === "flux-pro-ultra") {
    return "flux-kontext";
  }
  return "gpt-image-2";
}

/**
 * 이미지 생성. backend는 IMAGE_MODEL env로 결정.
 * - gpt-image-2 (default): OpenAI, reasoning 강함, multi-image OK, 살짝 painterly
 * - flux-kontext: fal.ai Flux Kontext Pro Max, photorealism 최강, multi-image OK
 */
export async function generateImage(
  opts: GenerateImageOptions
): Promise<GenerateImageResult & { backend: ImageBackend }> {
  const backend = getActiveImageBackend();
  if (backend === "flux-kontext") {
    const res = await generateImageFlux(opts);
    return { ...res, backend };
  }
  const res = await generateImageOpenAI(opts);
  return { ...res, backend };
}

export type { GenerateImageOptions, GenerateImageResult };
