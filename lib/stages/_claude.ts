// Stage 공용 Claude 호출 헬퍼.
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_MODEL, getAnthropic } from "../clients/anthropic";
import { parseLlmJson } from "../llm-json";

const USD_TO_KRW = 1380;
// claude-sonnet-4-6: $3/M input, $15/M output (approx)
const SONNET_INPUT_USD_PER_M = 3;
const SONNET_OUTPUT_USD_PER_M = 15;

// Anthropic API 이미지 단일 사이즈 한도 (대략). 초과 시 자동 스킵 + 경고.
const ANTHROPIC_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type ClaudeJsonResult<T> = {
  value: T;
  cost_krw: number;
  raw_text: string;
  input_tokens: number;
  output_tokens: number;
  skipped_images: string[];
};

const SYSTEM_JSON_ONLY =
  "You respond with valid JSON only. No markdown fences, no commentary, no explanations.";

export type ClaudeImageRef = {
  /** 로컬 파일 경로 (base64로 인코딩됨) */
  path: string;
};

export async function claudeJson<T>(
  userPrompt: string,
  options: {
    maxTokens?: number;
    system?: string;
    retries?: number;
    images?: ClaudeImageRef[];
  } = {}
): Promise<ClaudeJsonResult<T>> {
  const retries = options.retries ?? 1;
  const anthropic = getAnthropic();

  // 이미지 블록 빌드 (있으면)
  const { imageBlocks, skipped } = buildImageBlocks(options.images ?? []);

  const userContent =
    imageBlocks.length > 0
      ? [...imageBlocks, { type: "text" as const, text: userPrompt }]
      : userPrompt;

  const maxTokens = options.maxTokens ?? 4000;
  // Anthropic은 max_tokens가 크면 (>~16K) 10분 초과 가능성 때문에 streaming 강제.
  // 안전하게 8K 초과면 무조건 streaming 사용 (응답 형식은 동일).
  const useStreaming = maxTokens > 8000;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const params = {
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        system: options.system ?? SYSTEM_JSON_ONLY,
        messages: [{ role: "user" as const, content: userContent }],
      };
      const res = useStreaming
        ? await anthropic.messages.stream(params).finalMessage()
        : await anthropic.messages.create(params);
      const text = res.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n");
      // max_tokens 도달 → 응답이 중간에 잘림. 재시도해도 같은 문제 → 즉시 실패.
      if (res.stop_reason === "max_tokens") {
        throw new Error(
          `Claude 응답이 max_tokens(${maxTokens})에 도달해 JSON이 잘렸습니다. maxTokens를 늘려야 합니다. ` +
            `(출력 토큰: ${res.usage?.output_tokens ?? "?"})`
        );
      }
      const value = parseLlmJson<T>(text);
      const input_tokens = res.usage?.input_tokens ?? 0;
      const output_tokens = res.usage?.output_tokens ?? 0;
      const cost_usd =
        (input_tokens / 1_000_000) * SONNET_INPUT_USD_PER_M +
        (output_tokens / 1_000_000) * SONNET_OUTPUT_USD_PER_M;
      const cost_krw = Math.round(cost_usd * USD_TO_KRW);
      return {
        value,
        cost_krw,
        raw_text: text,
        input_tokens,
        output_tokens,
        skipped_images: skipped,
      };
    } catch (e) {
      lastError = e;
      // max_tokens 에러면 재시도해도 의미 없음
      if (e instanceof Error && e.message.includes("max_tokens")) break;
    }
  }
  throw new Error(
    `Claude JSON 호출 실패 (${retries + 1}회 시도): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

type AnthropicMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: AnthropicMime; data: string };
};

function buildImageBlocks(refs: ClaudeImageRef[]): {
  imageBlocks: ImageBlock[];
  skipped: string[];
} {
  const blocks: ImageBlock[] = [];
  const skipped: string[] = [];
  for (const ref of refs) {
    if (!fs.existsSync(ref.path)) {
      skipped.push(`${ref.path} (파일 없음)`);
      continue;
    }
    const stat = fs.statSync(ref.path);
    if (stat.size > ANTHROPIC_IMAGE_MAX_BYTES) {
      skipped.push(`${ref.path} (${(stat.size / 1024 / 1024).toFixed(1)}MB > 5MB)`);
      continue;
    }
    const mime = guessMime(ref.path);
    if (!mime) {
      skipped.push(`${ref.path} (지원 안 되는 형식)`);
      continue;
    }
    const data = fs.readFileSync(ref.path).toString("base64");
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: mime, data },
    });
  }
  return { imageBlocks: blocks, skipped };
}

function guessMime(p: string): AnthropicMime | null {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}
