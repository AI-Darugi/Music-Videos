import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, getJob } from "@/lib/db";
import { startJob } from "@/lib/orchestrator";
import { stageIndex } from "@/lib/stages";

export const runtime = "nodejs";

const BodySchema = z.object({
  // Cast review용
  removed_cast_ids: z.array(z.string()).optional(),
  // Keyframe review용
  removed_keyframe_scene_ids: z.array(z.string()).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (job.status !== "paused") {
    return NextResponse.json(
      { error: `job 상태가 paused가 아님: ${job.status}` },
      { status: 400 }
    );
  }
  if (!job.paused_at_stage) {
    return NextResponse.json(
      { error: "paused_at_stage가 비어 있어 어디서 재개할지 알 수 없음" },
      { status: 500 }
    );
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // body 비어도 OK
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const db = getDb();

  // pause 지점별 처리
  if (
    job.paused_at_stage === "creative-brief" ||
    job.paused_at_stage === "scene-multishot"
  ) {
    // Story/scenes review pause → 그냥 진행
    db.prepare(
      `UPDATE jobs SET status='pending', paused_at_stage=NULL, updated_at=? WHERE id=?`
    ).run(Date.now(), id);
  } else if (job.paused_at_stage === "character-style-sheet") {
    const removed = parsed.data.removed_cast_ids ?? [];
    db.prepare(
      `UPDATE jobs
       SET status = 'pending', paused_at_stage = NULL, cast_overrides = ?, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify({ removed_ids: removed }), Date.now(), id);
  } else if (job.paused_at_stage === "keyframes") {
    const removed = parsed.data.removed_keyframe_scene_ids ?? [];
    db.prepare(
      `UPDATE jobs
       SET status = 'pending', paused_at_stage = NULL, keyframe_overrides = ?, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify({ removed_scene_ids: removed }), Date.now(), id);
  } else {
    return NextResponse.json(
      { error: `알 수 없는 pause 지점: ${job.paused_at_stage}` },
      { status: 500 }
    );
  }

  const pausedIdx = stageIndex(job.paused_at_stage);
  const nextStage = stagesAfter(pausedIdx);
  if (!nextStage) {
    return NextResponse.json({ error: "재개할 다음 stage가 없습니다" }, { status: 500 });
  }

  startJob(id, nextStage);
  return NextResponse.json({ ok: true, resumed_from: nextStage });
}

function stagesAfter(idx: number): string | null {
  const mod = require("@/lib/stages") as { stages: Array<{ name: string }> };
  const next = mod.stages[idx + 1];
  return next?.name ?? null;
}
