// OpenAI — Whisper STT + gpt-image-2 이미지 생성 공유 클라이언트.
import fs from "node:fs";
import path from "node:path";
import OpenAI, { toFile } from "openai";

let _client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY 환경변수가 없습니다");
  _client = new OpenAI({ apiKey });
  return _client;
}

export const WHISPER_MODEL = "whisper-1";
export const IMAGE_MODEL = "gpt-image-2";

function detectAudioMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3" || ext === ".mpga" || ext === ".mpeg") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a" || ext === ".mp4") return "audio/mp4";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".ogg" || ext === ".oga") return "audio/ogg";
  if (ext === ".webm") return "audio/webm";
  return "application/octet-stream";
}

// USD → KRW 대략 환율 (정확한 비용 보정은 첫 호출 후)
const USD_TO_KRW = 1380;

// Whisper API: $0.006 per minute
const WHISPER_USD_PER_MIN = 0.006;

export type WhisperWord = {
  word: string;
  start: number;
  end: number;
};

export type WhisperSegment = {
  id?: number;
  start: number;
  end: number;
  text: string;
  /** 단어 단위 타임스탬프 (word granularity 요청 시) */
  words?: WhisperWord[];
};

export type TranscribeResult = {
  text: string;
  language?: string;
  duration?: number;
  segments: WhisperSegment[];
  cost_krw: number;
  raw: unknown;
};

export async function transcribeAudio(
  filePath: string,
  options: { language?: string } = {}
): Promise<TranscribeResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`오디오 파일이 없습니다: ${filePath}`);
  }
  const client = getOpenAI();
  const filename = path.basename(filePath);
  const mime = detectAudioMime(filePath);
  // toFile를 통해 안정적인 multipart 업로드 (Node 24 fetch 호환)
  const file = await toFile(fs.createReadStream(filePath), filename, {
    type: mime,
  });
  const res = await client.audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"],
    language: options.language,
  });

  // SDK 타입이 string | VerboseJson 유니온이라 안전하게 캐스팅
  const data = res as unknown as {
    text: string;
    language?: string;
    duration?: number;
    segments?: WhisperSegment[];
  };

  const duration = data.duration ?? 0;
  const cost_krw = Math.round(((duration / 60) * WHISPER_USD_PER_MIN) * USD_TO_KRW);

  return {
    text: data.text,
    language: data.language,
    duration: data.duration,
    segments: data.segments ?? [],
    cost_krw,
    raw: res,
  };
}

export type GenerateImageOptions = {
  prompt: string;
  size?: "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "low" | "medium" | "high" | "auto";
  outputPath: string;
  /** 참조 이미지 (multi-image input). 있으면 images.edit 사용. */
  references?: string[];
};

export type GenerateImageResult = {
  path: string;
  cost_krw: number;
  raw: unknown;
};

/**
 * gpt-image-2로 이미지 생성. references 있으면 edit 모드.
 * 비용은 토큰 기반($8/M input, $30/M output)이라 대략값. 실제 응답에서 보정.
 */
export async function generateImage(
  opts: GenerateImageOptions
): Promise<GenerateImageResult> {
  const client = getOpenAI();
  const size = opts.size ?? "1024x1024";
  const quality = opts.quality ?? "high";

  let raw: unknown;
  let b64: string | null = null;
  let usage:
    | { input_tokens?: number; output_tokens?: number }
    | undefined;

  if (opts.references && opts.references.length > 0) {
    // multi-image input: openai.images.edit
    const images = await Promise.all(
      opts.references.map(async (p, i) =>
        toFile(fs.createReadStream(p), `ref-${i}.png`, { type: "image/png" })
      )
    );
    // OpenAI SDK는 image: File | File[]를 모두 허용 (gpt-image-2에선 배열)
    const res = (await client.images.edit({
      model: IMAGE_MODEL,
      image: images.length === 1 ? images[0] : images,
      prompt: opts.prompt,
      size,
      // quality 필드는 일부 모델에서만 — 안전하게 cast
    } as Parameters<typeof client.images.edit>[0])) as {
      data?: Array<{ b64_json?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    raw = res;
    b64 = res.data?.[0]?.b64_json ?? null;
    usage = res.usage;
  } else {
    const res = await client.images.generate({
      model: IMAGE_MODEL,
      prompt: opts.prompt,
      size,
      quality: quality as "low" | "medium" | "high" | "auto",
    });
    raw = res;
    b64 = res.data?.[0]?.b64_json ?? null;
    usage = (res as { usage?: typeof usage }).usage;
  }

  if (!b64) {
    throw new Error("gpt-image-2가 이미지를 반환하지 않았습니다");
  }

  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  fs.writeFileSync(opts.outputPath, Buffer.from(b64, "base64"));

  const input_tokens = usage?.input_tokens ?? 0;
  const output_tokens = usage?.output_tokens ?? 0;
  // gpt-image-2: $8/M input, $30/M output (텍스트+이미지 토큰 합산 추정)
  const cost_usd = (input_tokens / 1_000_000) * 8 + (output_tokens / 1_000_000) * 30;
  const cost_krw = Math.round(cost_usd * USD_TO_KRW);

  return { path: opts.outputPath, cost_krw, raw };
}
