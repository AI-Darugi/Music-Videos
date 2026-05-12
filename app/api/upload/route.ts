// Vercel Blob 클라이언트 업로드용 토큰 엔드포인트.
// 브라우저가 직접 Blob storage로 업로드하면 4.5MB Vercel function body 한도를 우회.
// 사용: 클라이언트가 `@vercel/blob/client`의 `upload(file, { handleUploadUrl: "/api/upload" })` 호출.
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED_AUDIO = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/oga",
  "audio/webm",
];
const ALLOWED_IMAGE = ["image/jpeg", "image/png", "image/webp"];

// 클라이언트가 보낸 pathname의 prefix로 분류해서 콘텐츠 타입/사이즈 제한 적용
const PREFIXES = {
  audio: { types: ALLOWED_AUDIO, maxBytes: 80 * 1024 * 1024 }, // 80MB
  moodboard: { types: ALLOWED_IMAGE, maxBytes: 10 * 1024 * 1024 }, // 10MB/장
  protagonist: { types: ALLOWED_IMAGE, maxBytes: 10 * 1024 * 1024 }, // 10MB
} as const;

type Kind = keyof typeof PREFIXES;

function classify(pathname: string): Kind | null {
  if (pathname.startsWith("audio/")) return "audio";
  if (pathname.startsWith("moodboard/")) return "moodboard";
  if (pathname.startsWith("protagonist/")) return "protagonist";
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "서버에 BLOB_READ_WRITE_TOKEN이 설정되어 있지 않습니다" },
      { status: 500 }
    );
  }

  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const kind = classify(pathname);
        if (!kind) {
          throw new Error(
            "허용되지 않은 업로드 경로입니다 (audio/ moodboard/ protagonist/ 만 가능)"
          );
        }
        const { types, maxBytes } = PREFIXES[kind];
        return {
          allowedContentTypes: [...types],
          maximumSizeInBytes: maxBytes,
          // 토큰 만료 5분
          validUntil: Date.now() + 5 * 60 * 1000,
          // tokenPayload는 onUploadCompleted에서 검증용으로 사용 가능 (지금은 미사용)
          tokenPayload: JSON.stringify({ kind }),
        };
      },
      onUploadCompleted: async () => {
        // 클라이언트는 업로드 후 받은 URL을 그대로 /api/jobs로 보냄.
        // 여기서는 별도 후처리 없음 (DB는 /api/jobs에서 기록).
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : "업로드 토큰 발급 실패";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
