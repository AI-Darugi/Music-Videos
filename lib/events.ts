export type JobEvent =
  | { type: "snapshot"; jobId: string; job: unknown; logs: unknown }
  | { type: "stage_started"; jobId: string; stage: string }
  | {
      type: "stage_progress";
      jobId: string;
      stage: string;
      data: unknown;
    }
  | {
      type: "stage_completed";
      jobId: string;
      stage: string;
      data: unknown;
      cost_krw: number;
    }
  | { type: "stage_failed"; jobId: string; stage: string; error: string }
  | { type: "job_paused"; jobId: string; stage: string; reason: string }
  | { type: "job_completed"; jobId: string; result_path: string }
  | { type: "job_failed"; jobId: string; error: string };

type Listener = (e: JobEvent) => void;

const globalForEvents = globalThis as unknown as {
  _aiMvSubscribers?: Map<string, Set<Listener>>;
};

function getSubscribers(): Map<string, Set<Listener>> {
  if (!globalForEvents._aiMvSubscribers) {
    globalForEvents._aiMvSubscribers = new Map();
  }
  return globalForEvents._aiMvSubscribers;
}

export function subscribe(jobId: string, fn: Listener): () => void {
  const subs = getSubscribers();
  let set = subs.get(jobId);
  if (!set) {
    set = new Set();
    subs.set(jobId, set);
  }
  set.add(fn);
  return () => {
    const s = subs.get(jobId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subs.delete(jobId);
  };
}

export function publish(event: JobEvent): void {
  const set = getSubscribers().get(event.jobId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      // listener errors should not break the publisher
    }
  }
}
