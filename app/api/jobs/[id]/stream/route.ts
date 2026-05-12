import { getJob, getStageLogs } from "@/lib/db";
import { subscribe, type JobEvent } from "@/lib/events";
import { stageMeta } from "@/lib/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      const send = (event: object) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      const job = getJob(id);
      if (!job) {
        send({ type: "error", error: "job not found" });
        try {
          controller.close();
        } catch {}
        return;
      }
      const logs = getStageLogs(id);
      send({
        type: "snapshot",
        jobId: id,
        job,
        logs,
        stages: stageMeta(),
      });

      const unsubscribe = subscribe(id, (e: JobEvent) => {
        send(e);
        if (e.type === "job_completed" || e.type === "job_failed") {
          setTimeout(() => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            unsubscribe();
            try {
              controller.close();
            } catch {}
          }, 100);
        }
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {
          // ignore
        }
      }, 15_000);

      cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
