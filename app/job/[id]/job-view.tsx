"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowLeft,
  Check,
  Loader2,
  X,
  Clock,
  RefreshCw,
  Download,
  AlertTriangle,
  FileText,
  Image as ImageIcon,
  User,
  Link2,
} from "lucide-react";
import type { JobRow, JobUploads, StageLogRow } from "@/lib/db";

type StageMeta = { name: string; label: string };

type Props = {
  jobId: string;
  initial: {
    job: JobRow;
    logs: StageLogRow[];
    stages: StageMeta[];
    uploads: JobUploads;
    userLyrics: string | null;
  };
};

type LiveLog = {
  stage_name: string;
  status: "pending" | "running" | "completed" | "failed";
  data?: Record<string, unknown> | null;
  error?: string | null;
  cost_krw?: number;
  progress?: unknown[];
};

export function JobView({ jobId, initial }: Props) {
  const [job, setJob] = useState<JobRow>(initial.job);
  const [stages] = useState<StageMeta[]>(initial.stages);
  const [logs, setLogs] = useState<Record<string, LiveLog>>(() =>
    rowsToMap(initial.logs)
  );
  const [selected, setSelected] = useState<string>(
    () => initial.job.current_stage ?? initial.stages[0]?.name ?? ""
  );
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (msg) => {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(msg.data);
      } catch {
        return;
      }

      switch (evt.type) {
        case "snapshot": {
          if (evt.job) setJob(evt.job as JobRow);
          if (Array.isArray(evt.logs))
            setLogs(rowsToMap(evt.logs as StageLogRow[]));
          const status = (evt.job as JobRow | undefined)?.status;
          if (status === "completed" || status === "failed") {
            es.close();
          }
          break;
        }
        case "stage_started": {
          const stage = String(evt.stage);
          setLogs((prev) => ({
            ...prev,
            [stage]: { stage_name: stage, status: "running", progress: [] },
          }));
          setJob((j) => ({ ...j, current_stage: stage, status: "running" }));
          setSelected(stage);
          break;
        }
        case "stage_progress": {
          const stage = String(evt.stage);
          setLogs((prev) => ({
            ...prev,
            [stage]: {
              ...(prev[stage] ?? { stage_name: stage, status: "running" }),
              progress: [...(prev[stage]?.progress ?? []), evt.data],
            },
          }));
          break;
        }
        case "stage_completed": {
          const stage = String(evt.stage);
          setLogs((prev) => ({
            ...prev,
            [stage]: {
              ...(prev[stage] ?? { stage_name: stage, status: "completed" }),
              status: "completed",
              data: evt.data as Record<string, unknown> | null,
              cost_krw: Number(evt.cost_krw ?? 0),
            },
          }));
          break;
        }
        case "stage_failed": {
          const stage = String(evt.stage);
          setLogs((prev) => ({
            ...prev,
            [stage]: {
              ...(prev[stage] ?? { stage_name: stage, status: "failed" }),
              status: "failed",
              error: String(evt.error ?? "unknown error"),
            },
          }));
          break;
        }
        case "job_paused": {
          // 캐릭터 리뷰 대기 — UI 갱신
          fetch(`/api/jobs/${jobId}`)
            .then((r) => r.json())
            .then((data) => {
              if (data.job) setJob(data.job);
            })
            .catch(() => {});
          break;
        }
        case "job_completed":
        case "job_failed": {
          fetch(`/api/jobs/${jobId}`)
            .then((r) => r.json())
            .then((data) => {
              if (data.job) setJob(data.job);
              if (Array.isArray(data.logs))
                setLogs(rowsToMap(data.logs as StageLogRow[]));
            })
            .catch(() => {});
          break;
        }
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [jobId]);

  const totalCost = job.total_cost_krw ?? 0;
  const overallStatus = job.status;

  const selectedLog = logs[selected];
  const selectedMeta = stages.find((s) => s.name === selected);

  async function regenerate(stageName: string) {
    setRegenerating(stageName);
    try {
      await fetch(`/api/jobs/${jobId}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage_name: stageName }),
      });
    } finally {
      setRegenerating(null);
    }
  }

  const hasInputExtras =
    Boolean(initial.userLyrics) ||
    initial.uploads.moodboard.urls.length > 0 ||
    initial.uploads.protagonist.url !== null;

  return (
    <main className="flex-1 px-4 sm:px-6 py-6 max-w-7xl w-full mx-auto">
      <div className="flex items-center justify-between mb-6 gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition"
        >
          <ArrowLeft className="h-4 w-4" /> 새 뮤비 만들기
        </Link>
        <div className="flex items-center gap-3">
          <StatusBadge status={overallStatus} />
          <div className="text-sm">
            <span className="text-muted-foreground">누적 비용 </span>
            <span className="font-mono font-semibold">
              ₩{totalCost.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* 입력 섹션 */}
      <Card className="p-4 mb-6 border-white/10 bg-white/[0.02] backdrop-blur">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
          입력
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-start gap-2 text-sm">
            <Link2 className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">소스</div>
              {job.suno_url ? (
                <a
                  href={job.suno_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-300 hover:underline break-all"
                >
                  {job.suno_url}
                </a>
              ) : (
                <span className="text-muted-foreground">mp3 직접 업로드</span>
              )}
            </div>
          </div>

          {initial.userLyrics ? (
            <div className="flex items-start gap-2 text-sm">
              <FileText className="h-4 w-4 mt-0.5 text-emerald-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">사용자 가사</div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-emerald-300">
                    {initial.userLyrics.split(/\r?\n/).length}줄 ·{" "}
                    {initial.userLyrics.length}자 (펼치기)
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-black/30 p-2 font-mono whitespace-pre-wrap">
                    {initial.userLyrics}
                  </pre>
                </details>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <FileText className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <div className="text-xs">가사</div>
                <div className="text-xs">Whisper 자동 추출</div>
              </div>
            </div>
          )}
        </div>

        {hasInputExtras && (
          <>
            <Separator className="my-3 bg-white/10" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {initial.uploads.moodboard.urls.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-2 inline-flex items-center gap-1">
                    <ImageIcon className="h-3 w-3" /> 무드보드 (
                    {initial.uploads.moodboard.urls.length})
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {initial.uploads.moodboard.urls.map((u, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={i}
                        src={u}
                        alt={`mood-${i}`}
                        className="aspect-square w-full rounded border border-white/10 object-cover"
                      />
                    ))}
                  </div>
                </div>
              )}
              {initial.uploads.protagonist.url && (
                <div>
                  <div className="text-xs text-muted-foreground mb-2 inline-flex items-center gap-1">
                    <User className="h-3 w-3" /> 주인공 사진
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={initial.uploads.protagonist.url}
                    alt="protagonist"
                    className="aspect-square w-24 rounded border border-white/10 object-cover"
                  />
                </div>
              )}
            </div>
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <Card className="p-3 border-white/10 bg-white/[0.02] backdrop-blur h-fit">
          <ScrollArea className="max-h-[70vh]">
            <ul className="space-y-1">
              {stages.map((s, idx) => {
                const log = logs[s.name];
                const status = log?.status ?? "pending";
                const isActive = selected === s.name;
                return (
                  <li key={s.name}>
                    <button
                      onClick={() => setSelected(s.name)}
                      className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition ${
                        isActive
                          ? "bg-white/10 text-foreground"
                          : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                      }`}
                    >
                      <StageIcon status={status} />
                      <span className="text-[10px] font-mono text-muted-foreground w-4">
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                      <span className="flex-1">{s.label}</span>
                      {log?.cost_krw ? (
                        <span className="text-[10px] font-mono text-muted-foreground">
                          ₩{log.cost_krw.toLocaleString()}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        </Card>

        <Card className="p-6 border-white/10 bg-white/[0.02] backdrop-blur min-h-[60vh]">
          {selectedMeta ? (
            <StageDetailPanel
              meta={selectedMeta}
              log={selectedLog}
              overallStatus={overallStatus}
              regenerating={regenerating === selectedMeta.name}
              onRegenerate={() => regenerate(selectedMeta.name)}
            />
          ) : (
            <p className="text-muted-foreground">단계를 선택하세요.</p>
          )}
        </Card>
      </div>

      {overallStatus === "paused" && job.paused_at_stage === "creative-brief" && (
        <StoryReviewPanel
          jobId={jobId}
          briefData={logs["creative-brief"]?.data as Record<string, unknown> | undefined}
          onContinued={() => window.location.reload()}
        />
      )}

      {overallStatus === "paused" && job.paused_at_stage === "scene-multishot" && (
        <ScenesReviewPanel
          jobId={jobId}
          scenesData={logs["scene-multishot"]?.data as Record<string, unknown> | undefined}
          briefData={logs["creative-brief"]?.data as Record<string, unknown> | undefined}
          onContinued={() => window.location.reload()}
        />
      )}

      {overallStatus === "paused" && job.paused_at_stage === "character-style-sheet" && (
        <CastReviewPanel
          jobId={jobId}
          sheetsData={logs["character-style-sheet"]?.data as Record<string, unknown> | undefined}
          briefData={logs["creative-brief"]?.data as Record<string, unknown> | undefined}
          onContinued={() => window.location.reload()}
        />
      )}

      {overallStatus === "paused" && job.paused_at_stage === "keyframes" && (
        <KeyframeReviewPanel
          jobId={jobId}
          keyframesData={logs["keyframes"]?.data as Record<string, unknown> | undefined}
          scenesData={logs["scene-multishot"]?.data as Record<string, unknown> | undefined}
          onContinued={() => window.location.reload()}
        />
      )}

      {/* 자막 편집기 — Stage 02 음악 분석 완료 후 언제든 사용 가능 */}
      {logs["music-analysis"]?.status === "completed" && (
        <SubtitleEditor jobId={jobId} />
      )}

      {overallStatus === "completed" && job.result_path && (
        <Card className="mt-6 p-6 border-emerald-500/30 bg-emerald-500/5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-emerald-400 mb-1">완료</p>
              <h3 className="text-lg font-semibold">최종 결과</h3>
              <p className="text-xs text-muted-foreground font-mono mt-1">
                {job.result_path}
              </p>
            </div>
            <a
              href={job.result_path}
              download
              className="inline-flex items-center gap-2 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 transition"
            >
              <Download className="h-4 w-4" /> 다운로드
            </a>
          </div>
          {job.result_path.endsWith(".mp4") && (
            <video
              src={job.result_path}
              controls
              className="mt-4 w-full rounded-md border border-white/10"
            />
          )}
        </Card>
      )}

      {overallStatus === "failed" && job.error && (
        <Card className="mt-6 p-6 border-red-500/30 bg-red-500/5">
          <p className="text-xs text-red-400 mb-1">실패</p>
          <h3 className="text-lg font-semibold">파이프라인 중단</h3>
          <pre className="mt-2 text-sm whitespace-pre-wrap font-mono text-red-300">
            {job.error}
          </pre>
        </Card>
      )}
    </main>
  );
}

function StageDetailPanel({
  meta,
  log,
  overallStatus,
  regenerating,
  onRegenerate,
}: {
  meta: StageMeta;
  log?: LiveLog;
  overallStatus: JobRow["status"];
  regenerating: boolean;
  onRegenerate: () => void;
}) {
  const status = log?.status ?? "pending";
  const data = (log?.data ?? {}) as Record<string, unknown>;
  const canRegenerate =
    status !== "running" &&
    overallStatus !== "running" &&
    overallStatus !== "pending";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{meta.label}</h2>
          <p className="text-xs text-muted-foreground font-mono mt-1">
            {meta.name}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          {canRegenerate && (
            <Button
              size="sm"
              variant="outline"
              onClick={onRegenerate}
              disabled={regenerating}
            >
              {regenerating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              <span className="ml-1">이 단계부터 재실행</span>
            </Button>
          )}
        </div>
      </div>

      <Separator className="bg-white/10" />

      {log?.error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          <p className="font-medium mb-1 inline-flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> 오류
          </p>
          <pre className="whitespace-pre-wrap font-mono text-xs">
            {log.error}
          </pre>
        </div>
      )}

      {/* 단계별 특화 표시 */}
      <StageSpecificView stageName={meta.name} data={data} />

      {/* 진행 이벤트 */}
      {log?.progress && log.progress.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
            진행 이벤트
          </p>
          <pre className="text-xs bg-black/30 rounded-md p-3 overflow-auto max-h-64 font-mono">
            {JSON.stringify(log.progress, null, 2)}
          </pre>
        </div>
      )}

      {/* raw data */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          원본 데이터 펼치기
        </summary>
        <pre className="mt-2 bg-black/30 rounded-md p-3 overflow-auto max-h-96 font-mono">
          {log?.data ? JSON.stringify(log.data, null, 2) : "(없음)"}
        </pre>
      </details>
    </div>
  );
}

function StageSpecificView({
  stageName,
  data,
}: {
  stageName: string;
  data: Record<string, unknown>;
}) {
  if (stageName === "music-analysis") {
    const src = data.transcript_source as string | undefined;
    const conf = data.alignment_confidence as string | null | undefined;
    const warnings = data.alignment_warnings as string[] | undefined;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {src === "user_aligned" ? (
            <Badge
              variant="outline"
              className="bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
            >
              ✨ 사용자 가사 (Whisper 정렬)
            </Badge>
          ) : src === "whisper" ? (
            <Badge variant="outline" className="bg-white/10 text-muted-foreground">
              🎤 Whisper 자동 추출
            </Badge>
          ) : null}
          {conf === "high" && (
            <Badge
              variant="outline"
              className="bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
            >
              정렬 신뢰도: high ✓
            </Badge>
          )}
          {conf === "medium" && (
            <Badge
              variant="outline"
              className="bg-amber-500/15 text-amber-300 border-amber-500/40"
            >
              정렬 신뢰도: medium ⚠ 일부 sync 부정확 가능
            </Badge>
          )}
          {conf === "low" && (
            <Badge
              variant="outline"
              className="bg-red-500/15 text-red-300 border-red-500/40"
            >
              정렬 신뢰도: low ⚠ Whisper로 fallback 권장
            </Badge>
          )}
        </div>
        {warnings && warnings.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
            <p className="font-medium mb-1">경고</p>
            <ul className="list-disc pl-5 space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <FieldGrid
          fields={[
            ["mood", data.mood],
            ["tempo", data.tempo_feel],
            ["genre", data.estimated_genre],
            ["language", data.language],
            [
              "is_instrumental",
              data.is_instrumental === true ? "yes" : "no",
            ],
            ["duration", `${Number(data.duration ?? 0).toFixed(1)}s`],
          ]}
        />
        {Array.isArray(data.keywords) && data.keywords.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              keywords
            </div>
            <div className="flex flex-wrap gap-1">
              {(data.keywords as string[]).map((k, i) => (
                <Badge key={i} variant="outline" className="text-xs">
                  {k}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (stageName === "style-framework") {
    const palette = (data.color_palette as string[] | undefined) ?? [];
    return (
      <div className="space-y-3">
        <FieldGrid
          fields={[
            ["visual_style", data.visual_style],
            ["aspect_ratio", data.aspect_ratio],
            ["lighting", data.lighting],
            ["camera_style", data.camera_style],
          ]}
        />
        {palette.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              color palette
            </div>
            <div className="flex gap-2">
              {palette.map((c, i) => (
                <div key={i} className="flex flex-col items-center gap-1">
                  <div
                    className="h-12 w-12 rounded-md border border-white/10"
                    style={{ backgroundColor: c }}
                  />
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {c}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {data.moodboard_used === true && (
          <Badge
            variant="outline"
            className="bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
          >
            🎨 무드보드 반영됨{" "}
            {typeof data.moodboard_influence === "string"
              ? `· ${data.moodboard_influence}`
              : ""}
          </Badge>
        )}
      </div>
    );
  }

  if (stageName === "character-style-sheet") {
    const src = data.protagonist_source as string | undefined;
    const policyWarning = data.policy_warning as string | null | undefined;
    const charUrl = data.character_sheet_url as string | undefined;
    const styleUrl = data.style_sheet_url as string | undefined;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {src === "uploaded_photo" && (
            <Badge
              variant="outline"
              className="bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
            >
              👤 업로드 사진 기반
            </Badge>
          )}
          {src === "generated_character" && (
            <Badge variant="outline" className="bg-white/10 text-muted-foreground">
              AI 생성 (텍스트 기반)
            </Badge>
          )}
          {src === "abstract_moodboard" && (
            <Badge variant="outline" className="bg-white/10 text-muted-foreground">
              추상/풍경 모드
            </Badge>
          )}
          {data.moodboard_used === true && (
            <Badge variant="outline" className="text-xs">
              무드보드 ref 사용
            </Badge>
          )}
        </div>
        {policyWarning && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
            <p className="font-medium mb-1 inline-flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> OpenAI 정책 거부
            </p>
            <p className="text-xs">{policyWarning}</p>
            <p className="text-xs mt-1 text-red-300/70">
              다른 사진으로 재시도하거나 텍스트 기반 결과를 사용하세요.
            </p>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {charUrl && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">
                캐릭터 시트
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={charUrl}
                alt="character sheet"
                className="w-full rounded-md border border-white/10"
              />
            </div>
          )}
          {styleUrl && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">
                스타일 시트
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={styleUrl}
                alt="style sheet"
                className="w-full rounded-md border border-white/10"
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (stageName === "keyframes") {
    const kfs = (data.keyframes as Array<{ scene_id: string; url: string }> | undefined) ?? [];
    if (kfs.length === 0) return null;
    return (
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
          키프레임 ({kfs.length})
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {kfs.map((k) => (
            <div key={k.scene_id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={k.url}
                alt={k.scene_id}
                className="w-full rounded-md border border-white/10"
              />
              <div className="text-[10px] text-muted-foreground mt-1 text-center font-mono">
                {k.scene_id}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (stageName === "video-generation") {
    const succ = (data.succeeded as Array<{ scene_id: string; clip_path: string }> | undefined) ?? [];
    const failed = (data.failed as Array<{ scene_id: string; error: string }> | undefined) ?? [];
    return (
      <div className="space-y-3">
        {succ.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              완료 클립 ({succ.length})
            </div>
            <ul className="space-y-1">
              {succ.map((c) => (
                <li
                  key={c.scene_id}
                  className="flex items-center gap-2 text-xs font-mono"
                >
                  <Check className="h-3 w-3 text-emerald-400" />
                  <span className="text-muted-foreground">{c.scene_id}</span>
                  <span className="text-muted-foreground/60 truncate">
                    {c.clip_path}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {failed.length > 0 && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
            <div className="text-xs text-red-300 font-medium mb-1">
              실패한 scene ({failed.length})
            </div>
            <ul className="text-xs space-y-0.5 text-red-300/80">
              {failed.map((f) => (
                <li key={f.scene_id}>
                  <span className="font-mono">{f.scene_id}</span>: {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return null;
}

function FieldGrid({ fields }: { fields: Array<[string, unknown]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {fields.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="font-mono">{formatValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

function rowsToMap(rows: StageLogRow[]): Record<string, LiveLog> {
  const map: Record<string, LiveLog> = {};
  for (const r of rows) {
    let data: Record<string, unknown> | null = null;
    if (r.data_json) {
      try {
        const parsed = JSON.parse(r.data_json);
        data = parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        data = null;
      }
    }
    map[r.stage_name] = {
      stage_name: r.stage_name,
      status: r.status,
      data,
      error: r.error,
      cost_krw: r.cost_krw,
    };
  }
  return map;
}

function StageIcon({
  status,
}: {
  status: "pending" | "running" | "completed" | "failed";
}) {
  if (status === "completed")
    return (
      <Check className="h-4 w-4 text-emerald-400 shrink-0" strokeWidth={3} />
    );
  if (status === "failed")
    return <X className="h-4 w-4 text-red-400 shrink-0" strokeWidth={3} />;
  if (status === "running")
    return (
      <Loader2 className="h-4 w-4 text-emerald-400 shrink-0 animate-spin" />
    );
  return <Clock className="h-4 w-4 text-muted-foreground/40 shrink-0" />;
}

function SubtitleEditor({ jobId }: { jobId: string }) {
  type Segment = { start: number; end: number; text: string };
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [source, setSource] = useState<"user" | "auto" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || segments.length > 0) return;
    setLoading(true);
    setError(null);
    fetch(`/api/jobs/${jobId}/subtitles`)
      .then((r) => r.json())
      .then((data: { source: "user" | "auto" | null; segments: Segment[] }) => {
        setSegments(data.segments ?? []);
        setSource(data.source);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, jobId, segments.length]);

  function update(idx: number, patch: Partial<Segment>) {
    setSegments((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s))
    );
  }

  function removeRow(idx: number) {
    setSegments((prev) => prev.filter((_, i) => i !== idx));
  }

  function addRow(afterIdx: number) {
    setSegments((prev) => {
      const ref = prev[afterIdx];
      const newSeg: Segment = {
        start: ref ? ref.end + 0.1 : 0,
        end: ref ? ref.end + 2 : 2,
        text: "",
      };
      const copy = [...prev];
      copy.splice(afterIdx + 1, 0, newSeg);
      return copy;
    });
  }

  async function save() {
    setError(null);
    setSavedMsg(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/subtitles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `저장 실패 (${res.status})`);
      }
      setSavedMsg(
        "✅ 저장됨. Stage 09 ('병합 및 마무리')에서 '이 단계부터 재실행' 누르면 새 자막으로 영상 다시 burn (₩0)."
      );
      setSource("user");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-6 p-4 border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-emerald-400" />
          <span className="text-sm font-semibold">📝 자막 편집</span>
          {source === "user" && (
            <Badge
              variant="outline"
              className="text-[10px] bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
            >
              사용자 편집본
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {open ? "▼ 접기" : "▶ 펼치기"}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            자막 텍스트와 시간(초)을 직접 수정하세요. 저장 후 Stage 09 재실행하면
            영상에 반영됩니다. ffmpeg만 다시 돌리니까 ₩0.
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 자막 불러오는 중...
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}
          {savedMsg && (
            <p className="text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
              {savedMsg}
            </p>
          )}

          {!loading && segments.length > 0 && (
            <ScrollArea className="max-h-[60vh] pr-3">
              <ul className="space-y-2">
                {segments.map((s, i) => (
                  <li
                    key={i}
                    className="flex gap-2 items-start rounded-md border border-white/10 bg-black/20 p-2"
                  >
                    <span className="text-[10px] font-mono text-muted-foreground pt-2 w-8 shrink-0">
                      #{i + 1}
                    </span>
                    <div className="flex flex-col gap-1 shrink-0 w-24">
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={s.start}
                        onChange={(e) =>
                          update(i, { start: Number(e.target.value) })
                        }
                        className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-xs font-mono"
                      />
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={s.end}
                        onChange={(e) =>
                          update(i, { end: Number(e.target.value) })
                        }
                        className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-xs font-mono"
                      />
                    </div>
                    <textarea
                      value={s.text}
                      onChange={(e) => update(i, { text: e.target.value })}
                      rows={2}
                      className="flex-1 rounded border border-white/10 bg-black/30 p-2 text-sm font-mono"
                    />
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => addRow(i)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded bg-white/10 text-white hover:bg-emerald-500/40 text-xs"
                        title="아래에 추가"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded bg-white/10 text-white hover:bg-red-500/60 text-xs"
                        title="삭제"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}

          {!loading && segments.length === 0 && (
            <p className="text-sm text-muted-foreground italic">
              (자막 데이터 없음 — Stage 02 음악 분석이 완료되어야 함)
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSegments([]);
                setOpen(false);
              }}
            >
              취소
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={saving || segments.length === 0}
              className="bg-emerald-500 hover:bg-emerald-400 text-black"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  저장 중...
                </>
              ) : (
                `${segments.length}줄 저장`
              )}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function StoryReviewPanel({
  jobId,
  briefData,
  onContinued,
}: {
  jobId: string;
  briefData: Record<string, unknown> | undefined;
  onContinued: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const concept = typeof briefData?.concept === "string" ? briefData.concept : "";
  const narrative =
    typeof briefData?.narrative_arc === "string" ? briefData.narrative_arc : "";
  const cast = Array.isArray(briefData?.cast)
    ? (briefData.cast as Array<{ id: string; role: string; appearance_signature: string }>)
    : [];
  const setting =
    briefData?.setting && typeof briefData.setting === "object"
      ? (briefData.setting as {
          primary_location?: string;
          secondary_locations?: string[];
          world_description?: string;
        })
      : null;
  const themes = Array.isArray(briefData?.themes) ? (briefData.themes as string[]) : [];
  const motifs = Array.isArray(briefData?.visual_motifs)
    ? (briefData.visual_motifs as string[])
    : [];

  async function approve() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `요청 실패 (${res.status})`);
      }
      onContinued();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <Card className="mt-6 p-6 border-amber-500/40 bg-amber-500/5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-xs text-amber-400 mb-1">확인 대기 · 스토리 리뷰</p>
          <h3 className="text-lg font-semibold">스토리 / 컨셉 확인</h3>
          <p className="text-sm text-muted-foreground mt-1">
            이미지 만들기 전에 AI가 짠 스토리부터 확인. 별로면 "creative-brief"
            단계 옆 <span className="font-mono">이 단계부터 재실행</span> 누르세요 (₩30).
          </p>
        </div>
        <Button
          size="lg"
          onClick={approve}
          disabled={submitting}
          className="bg-emerald-500 hover:bg-emerald-400 text-black shrink-0"
        >
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              진행 중...
            </>
          ) : (
            "스토리 OK → 캐릭터 시트 생성 →"
          )}
        </Button>
      </div>

      {error && (
        <p className="mb-3 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="space-y-4">
        {concept && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              컨셉
            </div>
            <p className="text-base">{concept}</p>
          </div>
        )}
        {narrative && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              내러티브 (기-승-전-결)
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {narrative}
            </p>
          </div>
        )}
        {cast.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              등장인물 ({cast.length}명)
            </div>
            <ul className="space-y-2">
              {cast.map((c) => (
                <li
                  key={c.id}
                  className="rounded-md border border-white/10 bg-white/[0.02] p-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold">{c.role}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {c.id}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {c.appearance_signature}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {setting && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              세팅
            </div>
            <p className="text-sm">{setting.primary_location}</p>
            {setting.world_description && (
              <p className="text-xs text-muted-foreground mt-1">
                {setting.world_description}
              </p>
            )}
          </div>
        )}
        {themes.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              테마
            </div>
            <div className="flex flex-wrap gap-1">
              {themes.map((t, i) => (
                <Badge key={i} variant="outline">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {motifs.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              시각 모티프
            </div>
            <div className="flex flex-wrap gap-1">
              {motifs.map((m, i) => (
                <Badge key={i} variant="outline" className="text-xs">
                  {m}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function ScenesReviewPanel({
  jobId,
  scenesData,
  briefData,
  onContinued,
}: {
  jobId: string;
  scenesData: Record<string, unknown> | undefined;
  briefData: Record<string, unknown> | undefined;
  onContinued: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  type Scene = {
    id: string;
    narrative_purpose?: string;
    cast_in_scene?: string[];
    covers_sections?: string[];
  };
  const scenes = Array.isArray(scenesData?.scenes)
    ? (scenesData.scenes as Scene[])
    : [];
  const cast = Array.isArray(briefData?.cast)
    ? (briefData.cast as Array<{ id: string; role: string }>)
    : [];
  const castById = new Map(cast.map((c) => [c.id, c.role]));

  async function approve() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `요청 실패 (${res.status})`);
      }
      onContinued();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <Card className="mt-6 p-6 border-amber-500/40 bg-amber-500/5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-xs text-amber-400 mb-1">확인 대기 · 장면 리뷰</p>
          <h3 className="text-lg font-semibold">
            {scenes.length}개 scene 흐름 확인
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            이미지 만들기 전에 scene별 narrative 점검. 별로면 "scene-multishot"
            단계 옆 <span className="font-mono">이 단계부터 재실행</span> 누르세요 (₩100).
          </p>
        </div>
        <Button
          size="lg"
          onClick={approve}
          disabled={submitting}
          className="bg-emerald-500 hover:bg-emerald-400 text-black shrink-0"
        >
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              진행 중...
            </>
          ) : (
            "scene OK → 키프레임 생성 →"
          )}
        </Button>
      </div>

      {error && (
        <p className="mb-3 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <ScrollArea className="max-h-[60vh]">
        <ol className="space-y-2">
          {scenes.map((s, idx) => (
            <li
              key={s.id}
              className="rounded-md border border-white/10 bg-white/[0.02] p-3"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono text-emerald-400">
                  Scene {idx + 1}
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {s.id}
                </span>
                {(s.cast_in_scene ?? []).length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    👤 {(s.cast_in_scene ?? [])
                      .map((id) => castById.get(id) ?? id)
                      .join(", ")}
                  </span>
                )}
                {(s.covers_sections ?? []).length > 0 && (
                  <span className="text-[10px] text-muted-foreground/60">
                    {(s.covers_sections ?? []).join(" · ")}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {s.narrative_purpose ?? "(설명 없음)"}
              </p>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </Card>
  );
}

function CastReviewPanel({
  jobId,
  sheetsData,
  briefData,
  onContinued,
}: {
  jobId: string;
  sheetsData: Record<string, unknown> | undefined;
  briefData: Record<string, unknown> | undefined;
  onContinued: () => void;
}) {
  type Sheet = {
    cast_id: string;
    cast_role: string;
    url: string;
    source: string;
    policy_warning: string | null;
  };
  type CastInfo = {
    id: string;
    role: string;
    appearance_signature: string;
    personality?: string;
    wardrobe?: string;
  };

  const initialSheets = Array.isArray(sheetsData?.character_sheets)
    ? (sheetsData?.character_sheets as Sheet[])
    : [];
  const cast = Array.isArray(briefData?.cast)
    ? (briefData?.cast as CastInfo[])
    : [];

  const [sheets, setSheets] = useState<Sheet[]>(initialSheets);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [memos, setMemos] = useState<Record<string, string>>({});
  const [memoOpen, setMemoOpen] = useState<Set<string>>(new Set());
  const [regenerating, setRegenerating] = useState<Set<string>>(new Set());
  const [regenCount, setRegenCount] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(castId: string) {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(castId)) next.delete(castId);
      else next.add(castId);
      return next;
    });
  }

  function toggleMemo(castId: string) {
    setMemoOpen((prev) => {
      const next = new Set(prev);
      if (next.has(castId)) next.delete(castId);
      else next.add(castId);
      return next;
    });
  }

  async function regenerate(castId: string) {
    setError(null);
    setRegenerating((prev) => new Set(prev).add(castId));
    try {
      const res = await fetch(`/api/jobs/${jobId}/regenerate-sheet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cast_id: castId,
          prompt_addition: memos[castId] || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `재생성 실패 (${res.status})`);
      }
      const { url } = (await res.json()) as { url: string };
      // cache-bust로 새 이미지 표시
      const bustedUrl = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
      setSheets((prev) =>
        prev.map((s) => (s.cast_id === castId ? { ...s, url: bustedUrl } : s))
      );
      setRegenCount((prev) => ({ ...prev, [castId]: (prev[castId] ?? 0) + 1 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating((prev) => {
        const next = new Set(prev);
        next.delete(castId);
        return next;
      });
    }
  }

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          removed_cast_ids: Array.from(removed),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `요청 실패 (${res.status})`);
      }
      onContinued();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const activeCount = sheets.length - removed.size;

  return (
    <Card className="mt-6 p-6 border-amber-500/40 bg-amber-500/5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-xs text-amber-400 mb-1">확인 대기</p>
          <h3 className="text-lg font-semibold">캐릭터 확인 후 진행</h3>
          <p className="text-sm text-muted-foreground mt-1">
            AI가 곡 컨셉에서 {sheets.length}명의 cast를 뽑았어요. 필요 없는 인물은
            ❌ 눌러 제거하고 계속하세요.
          </p>
        </div>
        <Button
          size="lg"
          onClick={submit}
          disabled={submitting || activeCount === 0}
          className="bg-emerald-500 hover:bg-emerald-400 text-black"
        >
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              진행 중...
            </>
          ) : (
            `${activeCount}명으로 계속 진행 →`
          )}
        </Button>
      </div>

      {error && (
        <p className="mb-3 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        {sheets.map((s) => {
          const info = cast.find((c) => c.id === s.cast_id);
          const isRemoved = removed.has(s.cast_id);
          const isRegen = regenerating.has(s.cast_id);
          const regenN = regenCount[s.cast_id] ?? 0;
          const memoShown = memoOpen.has(s.cast_id);
          return (
            <div
              key={s.cast_id}
              className={`relative rounded-lg border overflow-hidden transition ${
                isRemoved
                  ? "border-red-500/40 opacity-40"
                  : "border-white/10 bg-white/[0.02]"
              }`}
            >
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={s.url}
                  alt={s.cast_role}
                  className="w-full aspect-[16/9] object-cover"
                />
                {isRegen && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <Loader2 className="h-6 w-6 text-emerald-400 animate-spin" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => toggle(s.cast_id)}
                  disabled={isRegen}
                  className={`absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-full transition ${
                    isRemoved
                      ? "bg-emerald-500 text-black hover:bg-emerald-400"
                      : "bg-black/70 text-white hover:bg-red-500"
                  }`}
                  aria-label={isRemoved ? "복원" : "제거"}
                  title={isRemoved ? "복원" : "제거"}
                >
                  {isRemoved ? <RefreshCw className="h-3 w-3" /> : <X className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => regenerate(s.cast_id)}
                  disabled={isRegen || isRemoved}
                  className="absolute top-2 right-11 inline-flex h-7 px-2 items-center justify-center rounded-full bg-black/70 text-white text-[10px] hover:bg-emerald-500/80 disabled:opacity-40 transition gap-1"
                  title="이 시트 재생성 (₩100)"
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>재생성</span>
                  {regenN > 0 && (
                    <span className="text-emerald-300 ml-0.5">×{regenN}</span>
                  )}
                </button>
              </div>
              <div className="p-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{s.cast_role}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {s.cast_id}
                  </span>
                  {s.source === "uploaded_photo" && (
                    <Badge variant="outline" className="text-[10px] bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                      업로드 기반
                    </Badge>
                  )}
                </div>
                {info?.appearance_signature && (
                  <p className="text-xs text-muted-foreground line-clamp-3">
                    {info.appearance_signature}
                  </p>
                )}
                {s.policy_warning && (
                  <p className="text-[11px] text-red-300 mt-1">
                    ⚠ {s.policy_warning}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => toggleMemo(s.cast_id)}
                  className="mt-1 text-[11px] text-muted-foreground hover:text-foreground transition"
                >
                  {memoShown ? "▼ 스타일 메모 숨김" : "▶ 스타일 메모 추가 (재생성 시 적용)"}
                </button>
                {memoShown && (
                  <textarea
                    value={memos[s.cast_id] ?? ""}
                    onChange={(e) =>
                      setMemos((prev) => ({ ...prev, [s.cast_id]: e.target.value }))
                    }
                    rows={2}
                    placeholder="예: 더 어둡고 차분한 톤. 머리 짧게. 영화 클래식 분위기."
                    className="w-full rounded-md border border-white/10 bg-black/30 p-2 text-xs font-mono focus:outline-none focus:border-emerald-400/40"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function KeyframeReviewPanel({
  jobId,
  keyframesData,
  scenesData,
  onContinued,
}: {
  jobId: string;
  keyframesData: Record<string, unknown> | undefined;
  scenesData: Record<string, unknown> | undefined;
  onContinued: () => void;
}) {
  type Keyframe = { scene_id: string; url: string; cost_krw?: number };
  const initial = Array.isArray(keyframesData?.keyframes)
    ? (keyframesData?.keyframes as Keyframe[])
    : [];
  const scenes = Array.isArray(scenesData?.scenes)
    ? (scenesData?.scenes as Array<{
        id: string;
        narrative_purpose?: string;
        cast_in_scene?: string[];
      }>)
    : [];

  const [keyframes, setKeyframes] = useState<Keyframe[]>(initial);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [memos, setMemos] = useState<Record<string, string>>({});
  const [memoOpen, setMemoOpen] = useState<Set<string>>(new Set());
  const [regenerating, setRegenerating] = useState<Set<string>>(new Set());
  const [regenCount, setRegenCount] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(sceneId: string) {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(sceneId)) next.delete(sceneId);
      else next.add(sceneId);
      return next;
    });
  }

  function toggleMemo(sceneId: string) {
    setMemoOpen((prev) => {
      const next = new Set(prev);
      if (next.has(sceneId)) next.delete(sceneId);
      else next.add(sceneId);
      return next;
    });
  }

  async function regenerate(sceneId: string) {
    setError(null);
    setRegenerating((prev) => new Set(prev).add(sceneId));
    try {
      const res = await fetch(`/api/jobs/${jobId}/regenerate-keyframe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scene_id: sceneId,
          prompt_addition: memos[sceneId] || undefined,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `재생성 실패 (${res.status})`);
      }
      const { url } = (await res.json()) as { url: string };
      const bustedUrl = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
      setKeyframes((prev) =>
        prev.map((k) => (k.scene_id === sceneId ? { ...k, url: bustedUrl } : k))
      );
      setRegenCount((prev) => ({
        ...prev,
        [sceneId]: (prev[sceneId] ?? 0) + 1,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating((prev) => {
        const next = new Set(prev);
        next.delete(sceneId);
        return next;
      });
    }
  }

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          removed_keyframe_scene_ids: Array.from(removed),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `요청 실패 (${res.status})`);
      }
      onContinued();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const activeCount = keyframes.length - removed.size;
  // 영상 단계 예상 비용 (10초 클립 ₩1,000 가정)
  const estVideoCost = activeCount * 1000;
  const savings = removed.size * 1000;

  return (
    <Card className="mt-6 p-6 border-amber-500/40 bg-amber-500/5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-xs text-amber-400 mb-1">확인 대기 · 키프레임 리뷰</p>
          <h3 className="text-lg font-semibold">키프레임 확인 후 영상 생성</h3>
          <p className="text-sm text-muted-foreground mt-1">
            {keyframes.length}개 키프레임 생성됨. 영상 만들기 전에 마음에 안 드는 거 ❌
            누르면 해당 scene은 영상 안 만들어요 (다른 클립으로 대체).
          </p>
          <p className="text-xs text-emerald-300 mt-2">
            영상 단계 예상 비용: ₩{estVideoCost.toLocaleString()}
            {savings > 0 && (
              <span className="text-amber-300 ml-2">(₩{savings.toLocaleString()} 절약)</span>
            )}
          </p>
        </div>
        <Button
          size="lg"
          onClick={submit}
          disabled={submitting || activeCount === 0}
          className="bg-emerald-500 hover:bg-emerald-400 text-black shrink-0"
        >
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              영상 생성 시작...
            </>
          ) : (
            `${activeCount}개 영상 생성 →`
          )}
        </Button>
      </div>

      {error && (
        <p className="mb-3 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {keyframes.map((kf, idx) => {
          const scene = scenes.find((s) => s.id === kf.scene_id);
          const isRemoved = removed.has(kf.scene_id);
          const isRegen = regenerating.has(kf.scene_id);
          const regenN = regenCount[kf.scene_id] ?? 0;
          const memoShown = memoOpen.has(kf.scene_id);
          return (
            <div
              key={kf.scene_id}
              className={`relative rounded-lg border overflow-hidden transition ${
                isRemoved
                  ? "border-red-500/40 opacity-30"
                  : "border-white/10 bg-white/[0.02] hover:border-white/30"
              }`}
            >
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={kf.url}
                  alt={kf.scene_id}
                  className="w-full aspect-video object-cover"
                />
                {isRegen && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <Loader2 className="h-5 w-5 text-emerald-400 animate-spin" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => toggle(kf.scene_id)}
                  disabled={isRegen}
                  className={`absolute top-1 right-1 inline-flex h-6 w-6 items-center justify-center rounded-full transition ${
                    isRemoved
                      ? "bg-emerald-500 text-black hover:bg-emerald-400"
                      : "bg-black/70 text-white hover:bg-red-500"
                  }`}
                  aria-label={isRemoved ? "복원" : "제거"}
                >
                  {isRemoved ? <RefreshCw className="h-3 w-3" /> : <X className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => regenerate(kf.scene_id)}
                  disabled={isRegen || isRemoved}
                  className="absolute bottom-1 right-1 inline-flex h-6 px-1.5 items-center gap-0.5 rounded bg-black/70 text-white text-[10px] hover:bg-emerald-500/80 disabled:opacity-40 transition"
                  title="이 키프레임 재생성 (₩100)"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  {regenN > 0 && <span className="text-emerald-300">×{regenN}</span>}
                </button>
              </div>
              <div className="p-2 space-y-0.5">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-mono text-muted-foreground">
                    #{idx + 1}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground/60">
                    {kf.scene_id}
                  </span>
                </div>
                {scene?.narrative_purpose && (
                  <p className="text-[11px] text-muted-foreground line-clamp-2">
                    {scene.narrative_purpose}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => toggleMemo(kf.scene_id)}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition"
                >
                  {memoShown ? "▼ 메모" : "▶ 메모"}
                </button>
                {memoShown && (
                  <textarea
                    value={memos[kf.scene_id] ?? ""}
                    onChange={(e) =>
                      setMemos((prev) => ({
                        ...prev,
                        [kf.scene_id]: e.target.value,
                      }))
                    }
                    rows={2}
                    placeholder="예: 더 어둡게, 클로즈업"
                    className="w-full rounded border border-white/10 bg-black/30 p-1.5 text-[10px] font-mono focus:outline-none focus:border-emerald-400/40"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function StatusBadge({
  status,
}: {
  status: "pending" | "running" | "paused" | "completed" | "failed";
}) {
  const variants: Record<typeof status, string> = {
    pending: "bg-white/10 text-muted-foreground border-white/10",
    running: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    paused: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    completed: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    failed: "bg-red-500/15 text-red-300 border-red-500/30",
  };
  const labels: Record<typeof status, string> = {
    pending: "대기",
    running: "진행 중",
    paused: "확인 대기",
    completed: "완료",
    failed: "실패",
  };
  return (
    <Badge variant="outline" className={variants[status]}>
      {labels[status]}
    </Badge>
  );
}
