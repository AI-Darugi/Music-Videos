import { NextResponse } from "next/server";
import { z } from "zod";
import { regenerateOneKeyframe } from "@/lib/regenerate";

export const runtime = "nodejs";

const BodySchema = z.object({
  scene_id: z.string().min(1),
  prompt_addition: z.string().max(500).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const result = await regenerateOneKeyframe({
      jobId: id,
      sceneId: parsed.data.scene_id,
      promptAddition: parsed.data.prompt_addition,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
