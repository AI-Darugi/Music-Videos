"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  Image as ImageIcon,
  Link2,
  Loader2,
  Music,
  Plus,
  Upload,
  User,
  X,
  FileText,
} from "lucide-react";

type Mode = "suno" | "upload";

const MAX_MOODBOARD = 5;
const MAX_LYRICS = 10_000;

export default function HomePage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("suno");
  const [sunoUrl, setSunoUrl] = useState("");
  const [mp3File, setMp3File] = useState<File | null>(null);

  // 추가 옵션
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [moodboard, setMoodboard] = useState<File[]>([]);
  const [protagonist, setProtagonist] = useState<File | null>(null);
  const [protagonistConsent, setProtagonistConsent] = useState(false);
  const [userLyrics, setUserLyrics] = useState("");
  const [videoMode, setVideoMode] = useState<"image-to-video" | "reference-to-video">(
    "image-to-video"
  );

  const [submitting, setSubmitting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasExtras = useMemo(
    () => moodboard.length > 0 || protagonist !== null || userLyrics.trim().length > 0,
    [moodboard, protagonist, userLyrics]
  );

  const lyricsCount = userLyrics.length;
  const lyricsOver = lyricsCount > MAX_LYRICS;

  const canSubmit =
    !submitting &&
    !lyricsOver &&
    (mode === "suno" ? sunoUrl.trim().length > 0 : mp3File !== null) &&
    (!protagonist || protagonistConsent);

  async function uploadToBlob(
    file: File,
    prefix: "audio" | "moodboard" | "protagonist"
  ): Promise<string> {
    // 안전한 pathname: prefix/<timestamp>-<random>.<ext>
    // (서버 /api/upload에서 prefix로 contentType/size 정책 분기)
    const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    const blob = await upload(`${prefix}/${safeName}`, file, {
      access: "public",
      handleUploadUrl: "/api/upload",
      contentType: file.type || undefined,
    });
    return blob.url;
  }

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    setUploadStatus(null);
    try {
      // 1) 큰 파일들은 클라이언트에서 직접 Vercel Blob으로 업로드.
      //    → Vercel function의 4.5MB body 한도(413) 우회.
      let mp3Url: string | null = null;
      const moodboardUrls: string[] = [];
      let protagonistUrl: string | null = null;

      if (mode === "upload" && mp3File) {
        setUploadStatus(`오디오 업로드 중... (${formatBytes(mp3File.size)})`);
        mp3Url = await uploadToBlob(mp3File, "audio");
      }
      if (moodboard.length > 0) {
        for (let i = 0; i < moodboard.length; i++) {
          setUploadStatus(`무드보드 업로드 ${i + 1}/${moodboard.length}...`);
          moodboardUrls.push(await uploadToBlob(moodboard[i], "moodboard"));
        }
      }
      if (protagonist) {
        setUploadStatus("주인공 사진 업로드 중...");
        protagonistUrl = await uploadToBlob(protagonist, "protagonist");
      }

      // 2) URL들과 메타데이터를 JSON으로 /api/jobs에 전송 (수 KB만)
      setUploadStatus("작업 생성 중...");
      const payload: Record<string, unknown> = {
        video_mode: videoMode,
      };
      if (mode === "suno") payload.suno_url = sunoUrl.trim();
      if (mp3Url) payload.mp3_url = mp3Url;
      if (moodboardUrls.length > 0) payload.moodboard_urls = moodboardUrls;
      if (protagonistUrl) {
        payload.protagonist_url = protagonistUrl;
        payload.protagonist_consent = true;
      }
      if (userLyrics.trim()) payload.user_lyrics = userLyrics;

      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? `요청 실패 (${res.status})`);
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/job/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
      setUploadStatus(null);
    }
  }

  const addMoodboard = useCallback(
    (files: FileList | File[]) => {
      // type이 비어있는 경우도 있어서 확장자 fallback
      const incoming = Array.from(files).filter(
        (f) =>
          f.type.startsWith("image/") ||
          /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name)
      );
      setMoodboard((prev) => [...prev, ...incoming].slice(0, MAX_MOODBOARD));
    },
    []
  );

  return (
    <main className="relative flex flex-1 items-center justify-center px-4 py-12 overflow-hidden">
      <BackgroundWaves />

      <div className="relative z-10 w-full max-w-2xl space-y-8">
        <header className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-muted-foreground">
            <Music className="h-3 w-3" />
            <span>AI Music Video Generator</span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight">
            Suno 링크 한 줄로
            <br />
            <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              AI 뮤직비디오
            </span>
            를 만드세요
          </h1>
          <p className="text-sm text-muted-foreground">
            예상 비용 약 5,000원 / 5분 곡 기준 · 약 5~8분 소요
          </p>
        </header>

        <Card className="p-6 space-y-4 border-white/10 bg-white/[0.02] backdrop-blur">
          <div className="flex gap-2">
            <ModeToggle
              active={mode === "suno"}
              onClick={() => setMode("suno")}
              icon={<Link2 className="h-4 w-4" />}
              label="Suno URL"
            />
            <ModeToggle
              active={mode === "upload"}
              onClick={() => setMode("upload")}
              icon={<Upload className="h-4 w-4" />}
              label="mp3 업로드"
            />
          </div>

          {mode === "suno" ? (
            <Input
              key="suno-url-input"
              type="url"
              placeholder="https://suno.com/song/..."
              value={sunoUrl}
              onChange={(e) => setSunoUrl(e.target.value)}
              className="h-12"
              disabled={submitting}
            />
          ) : (
            <Input
              key="audio-file-input"
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.webm"
              onChange={(e) => setMp3File(e.target.files?.[0] ?? null)}
              className="h-12 file:mr-3 file:bg-transparent file:text-foreground"
              disabled={submitting}
            />
          )}

          {/* 추가 옵션 */}
          <button
            type="button"
            className="w-full inline-flex items-center justify-between rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm transition hover:bg-white/[0.05]"
            onClick={() => setOptionsOpen((v) => !v)}
          >
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Plus className="h-4 w-4" />
              추가 옵션
              {hasExtras && (
                <Badge
                  variant="outline"
                  className="bg-emerald-500/10 text-emerald-300 border-emerald-500/30 ml-1"
                >
                  설정됨
                </Badge>
              )}
              {!hasExtras && userLyrics.length === 0 && (
                <Badge
                  variant="outline"
                  className="bg-amber-500/10 text-amber-300 border-amber-500/30 ml-1"
                >
                  💡 가사 추가 권장
                </Badge>
              )}
            </span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${optionsOpen ? "rotate-180" : ""}`}
            />
          </button>

          {optionsOpen && (
            <div className="space-y-5 rounded-md border border-white/10 bg-black/20 p-4">
              {/* 무드보드 */}
              <MoodboardField
                files={moodboard}
                onAdd={addMoodboard}
                onRemove={(i) =>
                  setMoodboard((prev) => prev.filter((_, idx) => idx !== i))
                }
                disabled={submitting}
              />

              {/* 주인공 사진 */}
              <ProtagonistField
                file={protagonist}
                onChange={setProtagonist}
                consent={protagonistConsent}
                onConsent={setProtagonistConsent}
                disabled={submitting}
              />

              {/* 가사 */}
              <LyricsField
                value={userLyrics}
                onChange={setUserLyrics}
                disabled={submitting}
                count={lyricsCount}
                over={lyricsOver}
              />

              {/* 영상 모드 토글 */}
              <VideoModeField
                value={videoMode}
                onChange={setVideoMode}
                disabled={submitting}
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <Button
            className="w-full h-12 text-base"
            onClick={submit}
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {uploadStatus ?? "생성 시작 중..."}
              </>
            ) : (
              "뮤직비디오 생성 시작"
            )}
          </Button>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          BytePlus Seedance 2.0 · OpenAI gpt-image-2 · Anthropic Claude
        </p>
      </div>
    </main>
  );
}

function MoodboardField({
  files,
  onAdd,
  onRemove,
  disabled,
}: {
  files: File[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (idx: number) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-sm font-medium">
          <ImageIcon className="h-4 w-4 text-emerald-400" />
          🎨 무드보드 이미지
        </label>
        <span className="text-xs text-muted-foreground">
          {files.length}/{MAX_MOODBOARD}
        </span>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onAdd(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-md border-2 border-dashed p-4 text-center transition ${
          drag
            ? "border-emerald-400/60 bg-emerald-500/5"
            : "border-white/10 hover:border-white/20"
        }`}
      >
        <p className="text-xs text-muted-foreground">
          드래그앤드롭 또는 클릭하여 이미지 추가 (최대 {MAX_MOODBOARD}장,
          각 10MB)
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) onAdd(e.target.files);
            e.target.value = "";
          }}
          disabled={disabled}
        />
      </div>
      {files.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {files.map((f, i) => (
            <Thumb
              key={`${f.name}-${i}`}
              file={f}
              onRemove={() => onRemove(i)}
            />
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        곡 분위기에 맞는 이미지 1~5장. 색감/조명/무드 reference로 사용됩니다.
      </p>
    </div>
  );
}

function ProtagonistField({
  file,
  onChange,
  consent,
  onConsent,
  disabled,
}: {
  file: File | null;
  onChange: (f: File | null) => void;
  consent: boolean;
  onConsent: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="inline-flex items-center gap-2 text-sm font-medium">
        <User className="h-4 w-4 text-emerald-400" />
        👤 주인공 사진
      </label>
      <div className="flex items-center gap-3">
        {file ? (
          <>
            <Thumb file={file} onRemove={() => onChange(null)} />
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onChange(null)}
            >
              제거
            </button>
          </>
        ) : (
          <Input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => onChange(e.target.files?.[0] ?? null)}
            className="h-10 file:mr-3 file:bg-transparent file:text-foreground"
            disabled={disabled}
          />
        )}
      </div>
      <label className="flex items-start gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => onConsent(e.target.checked)}
          disabled={disabled}
          className="mt-0.5"
        />
        <span className="text-muted-foreground">
          <span className="text-red-400 font-medium">⚠️ 본인 사진</span>임을
          확인합니다. 타인/연예인 사진은 OpenAI 정책 위반입니다.
        </span>
      </label>
    </div>
  );
}

function LyricsField({
  value,
  onChange,
  disabled,
  count,
  over,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  count: number;
  over: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="inline-flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 text-emerald-400" />
          📝 가사 직접 입력
          <span className="text-[11px] text-emerald-300 font-normal">
            (권장)
          </span>
        </label>
        <span
          className={`text-xs font-mono ${over ? "text-red-400" : "text-muted-foreground"}`}
        >
          {count.toLocaleString()}/{MAX_LYRICS.toLocaleString()}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={6}
        placeholder={`Suno에서 가사 복사해서 그대로 붙여넣으세요.
형식 신경 쓸 필요 없어요 — [Verse 1] 같은 라벨이 있어도 OK.

예시:
[Verse 1]
첫 줄 가사
두 줄 가사

[Chorus]
후렴 가사`}
        className="w-full rounded-md border border-white/10 bg-black/30 p-3 text-sm font-mono leading-relaxed focus:outline-none focus:border-emerald-400/40"
      />
      <p className="text-[11px] text-muted-foreground">
        💡 권장: Whisper 자동 추출보다 가사 직접 입력이 훨씬 정확해요. 한국어
        곡은 거의 필수입니다.
      </p>
    </div>
  );
}

function VideoModeField({
  value,
  onChange,
  disabled,
}: {
  value: "image-to-video" | "reference-to-video";
  onChange: (v: "image-to-video" | "reference-to-video") => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="inline-flex items-center gap-2 text-sm font-medium">
        🎬 영상 생성 모드
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onChange("image-to-video")}
          disabled={disabled}
          className={`text-left rounded-md border p-3 transition ${
            value === "image-to-video"
              ? "border-emerald-400/40 bg-emerald-400/10"
              : "border-white/10 bg-white/[0.02] hover:bg-white/5"
          }`}
        >
          <div className="text-sm font-medium mb-1">
            🖼️ Image-to-Video <span className="text-[10px] text-muted-foreground">(저렴)</span>
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            키프레임 만들고 그 이미지에서 영상 시작.
            <br />
            5분 곡 ≈ ₩20-30k.
            <br />
            중간에 키프레임 검수 가능 ✓
          </div>
        </button>
        <button
          type="button"
          onClick={() => onChange("reference-to-video")}
          disabled={disabled}
          className={`text-left rounded-md border p-3 transition ${
            value === "reference-to-video"
              ? "border-emerald-400/40 bg-emerald-400/10"
              : "border-white/10 bg-white/[0.02] hover:bg-white/5"
          }`}
        >
          <div className="text-sm font-medium mb-1">
            🎯 Reference-to-Video <span className="text-[10px] text-muted-foreground">(일관성 ↑)</span>
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            키프레임 skip + 캐릭터/스타일 시트 ref로 직접 영상.
            <br />
            인물 일관성 ↑. 비용은 모델 가격에 따라.
            <br />
            (Seedance 2.0 reference-to-video)
          </div>
        </button>
      </div>
    </div>
  );
}

function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string>("");
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div className="relative group aspect-square rounded-md overflow-hidden border border-white/10 bg-black/30">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="h-full w-full bg-white/5 animate-pulse" />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white hover:bg-red-500/80 transition"
        aria-label="제거"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function ModeToggle({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition ${
        active
          ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
          : "border-white/10 bg-transparent text-muted-foreground hover:bg-white/5"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function BackgroundWaves() {
  return (
    <div className="absolute inset-0 -z-0 overflow-hidden">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[120%] opacity-30">
        <svg
          viewBox="0 0 800 400"
          preserveAspectRatio="none"
          className="h-full w-full"
        >
          <defs>
            <linearGradient id="w1" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0" />
              <stop offset="50%" stopColor="#10b981" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="w2" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0" />
              <stop offset="50%" stopColor="#06b6d4" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M0 200 Q200 120 400 200 T800 200"
            stroke="url(#w1)"
            strokeWidth="1.5"
            fill="none"
          />
          <path
            d="M0 220 Q200 280 400 220 T800 220"
            stroke="url(#w2)"
            strokeWidth="1"
            fill="none"
          />
          <path
            d="M0 180 Q200 240 400 180 T800 180"
            stroke="url(#w2)"
            strokeWidth="1"
            fill="none"
          />
        </svg>
      </div>
    </div>
  );
}
