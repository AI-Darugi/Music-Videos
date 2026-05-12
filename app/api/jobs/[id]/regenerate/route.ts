import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, getJob } from "@/lib/db";
import { startJob } from "@/lib/orchestrator";
import { stageIndex } from "@/lib/stages";

export const runtime = "nodejs";

const BodySchema = z.object({
  stage_name: z.string().min(1),
});

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
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { stage_name } = parsed.data;
  if (stageIndex(stage_name) < 0) {
    return NextResponse.json(
      { error: `unknown stage: ${stage_name}` },
      { status: 400 }
    );
  }

  // 해당 stage 이후의 모든 stage_logs 삭제 (캐스케이드 재실행 위해)
  const db = getDb();
  db.prepare(
    `DELETE FROM stage_logs
     WHERE job_id = ?
       AND id >= COALESCE(
         (SELECT MIN(id) FROM stage_logs WHERE job_id = ? AND stage_name = ?),
         (SELECT COALESCE(MAX(id),0)+1 FROM stage_logs WHERE job_id = ?)
       )`
  ).run(id, id, stage_name, id);

  // 비용 재계산: 남은 완료 stage들의 cost_krw 합으로 리셋 (재실행 이중 카운트 방지)
  const remaining = db
    .prepare(
      "SELECT COALESCE(SUM(cost_krw),0) AS total FROM stage_logs WHERE job_id = ?"
    )
    .get(id) as { total: number };

  db.prepare(
    "UPDATE jobs SET status = 'pending', error = NULL, total_cost_krw = ?, updated_at = ? WHERE id = ?"
  ).run(remaining.total, Date.now(), id);

  startJob(id, stage_name);
  return NextResponse.json({ ok: true, restart_from: stage_name });
}
