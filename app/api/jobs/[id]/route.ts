import { NextResponse } from "next/server";
import { getJob, getStageLogs } from "@/lib/db";
import { stageMeta } from "@/lib/stages";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const logs = getStageLogs(id);
  return NextResponse.json({ job, logs, stages: stageMeta() });
}
