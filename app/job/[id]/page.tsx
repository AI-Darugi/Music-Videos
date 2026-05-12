import { notFound } from "next/navigation";
import { getJob, getJobUploads, getStageLogs } from "@/lib/db";
import { stageMeta } from "@/lib/stages";
import { JobView } from "./job-view";

export const dynamic = "force-dynamic";

export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) notFound();
  const logs = getStageLogs(id);
  const stages = stageMeta();
  const uploads = getJobUploads(job);

  return (
    <JobView
      jobId={id}
      initial={{ job, logs, stages, uploads, userLyrics: job.user_lyrics }}
    />
  );
}
