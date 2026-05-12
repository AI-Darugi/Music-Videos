import { NextResponse } from "next/server";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getJob } from "@/lib/db";

export const runtime = "nodejs";

const SegmentSchema = z.object({
  start: z.number().min(0).max(7200),
  end: z.number().min(0).max(7200),
  text: z.string().max(500),
});

const BodySchema = z.object({
  segments: z.array(SegmentSchema).max(500),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  const workspaceDir = path.join(process.cwd(), "workspace", id);
  const userPath = path.join(workspaceDir, "transcript-user.json");
  const autoPath = path.join(workspaceDir, "transcript.json");

  // 사용자 편집본 우선, 없으면 자동 생성본
  if (fs.existsSync(userPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(userPath, "utf-8")) as {
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      return NextResponse.json({
        source: "user",
        segments: data.segments ?? [],
      });
    } catch {
      // 손상 시 fall-through
    }
  }
  if (fs.existsSync(autoPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(autoPath, "utf-8")) as {
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      return NextResponse.json({
        source: "auto",
        segments: (data.segments ?? []).map((s) => ({
          start: s.start,
          end: s.end,
          text: s.text,
        })),
      });
    } catch {
      // ignore
    }
  }
  return NextResponse.json({ source: null, segments: [] });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid" },
      { status: 400 }
    );
  }

  // 유효성: start < end, start는 정렬되어 있어야 (들쑥날쑥 OK지만 경고 가능)
  for (const s of parsed.data.segments) {
    if (s.end <= s.start) {
      return NextResponse.json(
        { error: `잘못된 timing: start=${s.start} end=${s.end}` },
        { status: 400 }
      );
    }
  }

  const workspaceDir = path.join(process.cwd(), "workspace", id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const userPath = path.join(workspaceDir, "transcript-user.json");
  fs.writeFileSync(
    userPath,
    JSON.stringify(
      {
        segments: parsed.data.segments,
        source: "user_edited",
        edited_at: new Date().toISOString(),
      },
      null,
      2
    )
  );

  return NextResponse.json({ ok: true, count: parsed.data.segments.length });
}
