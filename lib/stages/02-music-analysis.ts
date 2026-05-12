import fs from "node:fs";
import path from "node:path";
import {
  transcribeAudio,
  type WhisperSegment,
} from "../clients/openai";
import { ensureWhisperFriendly } from "../audio-convert";
import { claudeJson } from "./_claude";
import type { Stage } from "../orchestrator";

type StructureSection = {
  section: "intro" | "verse" | "chorus" | "bridge" | "outro" | "interlude";
  label: string;
  start: number;
  end: number;
  lyrics_summary: string;
};

type AlignedSegment = {
  start: number;
  end: number;
  text: string;
  section: string | null;
};

type AlignmentResult = {
  aligned_segments: AlignedSegment[];
  alignment_confidence: "high" | "medium" | "low";
  warnings: string[];
};

type MusicAnalysis = {
  structure: StructureSection[];
  mood: string;
  tempo_feel: "slow" | "mid" | "fast";
  estimated_bpm: number | null;
  estimated_genre: string;
  keywords: string[];
  language: string;
  is_instrumental: boolean;
  emotional_arc: string;
};

export const stage: Stage = {
  name: "music-analysis",
  label: "음악 분석",
  async run({ workspaceDir, data, userLyrics }) {
    const input = data["input-analysis"] as
      | { mp3_path?: string; duration?: number; lyrics_hint?: string | null }
      | undefined;

    const mp3Path =
      input?.mp3_path ?? path.join(workspaceDir, "audio.mp3");
    if (!fs.existsSync(mp3Path)) {
      throw new Error(`mp3 파일이 없습니다: ${mp3Path}`);
    }

    // 1) Whisper STT — WAV/긴 파일은 자동으로 mp3 변환 (25MB 한도)
    const whisperPath = await ensureWhisperFriendly(mp3Path, workspaceDir);
    const transcript = await transcribeAudio(whisperPath);
    fs.writeFileSync(
      path.join(workspaceDir, "transcript-whisper.json"),
      JSON.stringify(transcript.raw, null, 2)
    );

    const duration =
      transcript.duration ?? input?.duration ?? estimateDuration(transcript.segments);

    let totalCost = transcript.cost_krw;
    let transcriptSource: "whisper" | "user_aligned" = "whisper";
    let alignmentConfidence: AlignmentResult["alignment_confidence"] | null = null;
    let alignmentWarnings: string[] = [];

    // 2) 사용자 가사 alignment (있으면)
    let alignedSegments: AlignedSegment[] | null = null;
    if (userLyrics && userLyrics.trim().length > 0 && transcript.segments.length > 0) {
      try {
        const alignPrompt = buildAlignmentPrompt({
          userLyrics: userLyrics.trim(),
          whisperSegments: transcript.segments,
          duration,
        });
        const alignRes = await claudeJson<AlignmentResult>(alignPrompt, {
          maxTokens: 16000,
        });
        totalCost += alignRes.cost_krw;
        if (
          Array.isArray(alignRes.value.aligned_segments) &&
          alignRes.value.aligned_segments.length > 0
        ) {
          // 자동 dedup + overlap 보정 (Claude가 중복 만들어도 깨끗하게)
          const { cleaned, fixes } = dedupAndFixAligned(
            alignRes.value.aligned_segments
          );
          alignedSegments = cleaned;
          alignmentConfidence = alignRes.value.alignment_confidence ?? "medium";
          alignmentWarnings = [...(alignRes.value.warnings ?? []), ...fixes];
          // dedup 수 자체가 많으면 신뢰도 한 단계 내림
          if (fixes.length >= 3 && alignmentConfidence === "high") {
            alignmentConfidence = "medium";
          }
          transcriptSource = "user_aligned";
        }
      } catch (e) {
        // alignment 실패 시 Whisper 결과 사용
        alignmentWarnings.push(
          `가사 alignment 실패, Whisper 결과로 fallback: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }

    // transcript.json 통합 저장 (자막 burn-in에서 사용)
    const finalSegments: WhisperSegment[] =
      alignedSegments?.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })) ?? transcript.segments;
    fs.writeFileSync(
      path.join(workspaceDir, "transcript.json"),
      JSON.stringify(
        {
          segments: finalSegments,
          aligned_sections: alignedSegments?.map((s) => s.section) ?? [],
          source: transcriptSource,
        },
        null,
        2
      )
    );

    // 3) Claude 구조 분석
    const isLikelyInstrumental =
      transcript.segments.length === 0 && (!userLyrics || userLyrics.trim().length < 5);

    const analysisPrompt = buildAnalysisPrompt({
      segments: alignedSegments ?? transcript.segments,
      duration,
      isLikelyInstrumental,
      lyricsHint: input?.lyrics_hint ?? null,
      userLyrics: userLyrics ?? null,
      transcriptSource,
    });

    const analysisRes = await claudeJson<MusicAnalysis>(analysisPrompt, {
      maxTokens: 8000,
    });
    totalCost += analysisRes.cost_krw;

    fs.writeFileSync(
      path.join(workspaceDir, "music-analysis.json"),
      JSON.stringify(analysisRes.value, null, 2)
    );

    // 템포에 따라 권장 씬 길이/개수 산출
    const recommendedSceneDurationSec = recommendSceneDuration(
      analysisRes.value.tempo_feel,
      analysisRes.value.estimated_bpm
    );
    // 슬롯당 unique scene 비율: 느린 곡은 reuse 더 많음 (더 적은 unique scene)
    const reuseRatio = scenesPerSlotRatio(
      analysisRes.value.tempo_feel,
      analysisRes.value.estimated_bpm
    );
    const SAFETY_MAX = 80; // 안전 상한 (7+분 빠른 곡 정도)
    const slotsNeeded = Math.ceil(duration / recommendedSceneDurationSec);
    const recommendedSceneCount = Math.min(
      SAFETY_MAX,
      Math.max(2, Math.ceil(slotsNeeded * reuseRatio))
    );

    return {
      data: {
        mood: analysisRes.value.mood,
        tempo_feel: analysisRes.value.tempo_feel,
        estimated_bpm: analysisRes.value.estimated_bpm,
        estimated_genre: analysisRes.value.estimated_genre,
        keywords: analysisRes.value.keywords,
        language: analysisRes.value.language,
        is_instrumental: analysisRes.value.is_instrumental,
        emotional_arc: analysisRes.value.emotional_arc,
        structure_sections: analysisRes.value.structure.length,
        duration,
        recommended_scene_duration_sec: recommendedSceneDurationSec,
        recommended_scene_count: recommendedSceneCount,
        transcript_source: transcriptSource,
        alignment_confidence: alignmentConfidence,
        alignment_warnings: alignmentWarnings,
        transcript_path: path.join(workspaceDir, "transcript.json"),
        analysis_path: path.join(workspaceDir, "music-analysis.json"),
      },
      cost_krw: totalCost,
    };
  },
};

function estimateDuration(segments: WhisperSegment[] | AlignedSegment[]): number {
  if (segments.length === 0) return 0;
  return segments[segments.length - 1].end;
}

/**
 * Claude가 만든 aligned_segments에서:
 *  - 동일 텍스트 + 비슷한 시간 → 중복 제거
 *  - 빈 텍스트 → 제거
 *  - 시간 overlap → 이전 end를 다음 start로 조정
 *  - 잘못된 timing (end <= start) → 제거
 */
function dedupAndFixAligned(input: AlignedSegment[]): {
  cleaned: AlignedSegment[];
  fixes: string[];
} {
  const fixes: string[] = [];
  // 1) 빈 텍스트 / 잘못된 timing 제거
  let segs = input.filter((s, i) => {
    if (!s.text || !s.text.trim()) {
      fixes.push(`#${i}: 빈 텍스트 제거`);
      return false;
    }
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) {
      fixes.push(`#${i}: 잘못된 timing 제거 (${s.start}→${s.end})`);
      return false;
    }
    return true;
  });

  // 2) start 시간순 정렬
  segs.sort((a, b) => a.start - b.start);

  // 3) 동일 텍스트 + 시간 근접 (<1.5s) → 중복 제거
  const dedup: AlignedSegment[] = [];
  for (const s of segs) {
    const last = dedup[dedup.length - 1];
    if (
      last &&
      normalize(last.text) === normalize(s.text) &&
      Math.abs(last.start - s.start) < 1.5
    ) {
      fixes.push(`중복 제거: "${truncate(s.text, 30)}" @ ${s.start.toFixed(1)}s`);
      // 시간 범위는 더 넓은 쪽으로 확장
      last.end = Math.max(last.end, s.end);
      continue;
    }
    dedup.push({ ...s });
  }

  // 4) overlap 보정: 이전 segment의 end가 다음 start보다 크면 잘라냄
  for (let i = 0; i < dedup.length - 1; i++) {
    const cur = dedup[i];
    const next = dedup[i + 1];
    if (cur.end > next.start) {
      const gap = 0.05;
      const newEnd = Math.max(cur.start + 0.3, next.start - gap);
      if (newEnd !== cur.end) {
        fixes.push(
          `overlap 보정: "${truncate(cur.text, 20)}" end ${cur.end.toFixed(1)}→${newEnd.toFixed(1)}s`
        );
        cur.end = newEnd;
      }
    }
  }

  segs = dedup;
  return { cleaned: segs, fixes };
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "...";
}

function recommendSceneDuration(
  tempoFeel: "slow" | "mid" | "fast" | undefined,
  bpm: number | null | undefined
): 5 | 10 {
  // 빠른 곡 → 5초 컷 자주, 중/느린 곡 → 10초 클립
  if (tempoFeel === "fast") return 5;
  if (typeof bpm === "number" && bpm >= 130) return 5;
  return 10;
}

/**
 * 슬롯 중 몇 %를 unique scene으로 할지.
 * - fast: 1.0 (모든 슬롯 새 영상)
 * - mid:  1.0 (모든 슬롯 새 영상)
 * - slow: 0.65 (1.5배 reuse — 같은 영상이 평균 1.5번 등장)
 */
function scenesPerSlotRatio(
  tempoFeel: "slow" | "mid" | "fast" | undefined,
  bpm: number | null | undefined
): number {
  if (tempoFeel === "slow") return 0.65;
  if (typeof bpm === "number" && bpm < 90) return 0.65;
  return 1.0;
}

function buildAlignmentPrompt(args: {
  userLyrics: string;
  whisperSegments: WhisperSegment[];
  duration: number;
}): string {
  return [
    "사용자가 제공한 정확한 가사와 Whisper가 추출한 타임스탬프를 매칭해주세요.",
    "",
    `곡 길이: ${args.duration.toFixed(1)}초`,
    "",
    "사용자 가사 (정확):",
    "```",
    args.userLyrics,
    "```",
    "",
    "Whisper 세그먼트 (타임스탬프 정확, 텍스트는 부정확할 수 있음):",
    args.whisperSegments
      .map((s) => `[${fmt(s.start)}-${fmt(s.end)}] ${s.text.trim()}`)
      .join("\n"),
    "",
    "규칙 (반드시 준수):",
    "- 사용자 가사를 자연스러운 라인 단위로 쪼개기 (보통 줄바꿈 그대로, 너무 긴 줄은 분할)",
    "- [Verse 1], [Chorus] 같은 섹션 라벨은 텍스트에서 제거하되, section 필드로 기록",
    "- 후렴 반복(x2 등)은 user_lyrics에 명시된 만큼만 펼침. 자의적 복제 금지.",
    "- Whisper에 없는 가사 라인이 있으면 (instrumental break 후 나오는 경우 등) 추정 타이밍 할당",
    "- Whisper에 있는데 사용자 가사에 없으면 무시 (Whisper 환청일 가능성)",
    "",
    "★ 절대 금지 (위반 시 자동 dedup 작동):",
    "- aligned_segments에 동일 text + 비슷한 시간 중복 등장 X",
    "- 시간 overlap X — 각 segment의 end ≤ 다음 segment의 start",
    "- 빈 텍스트 / end ≤ start인 잘못된 segment X",
    "- 같은 가사 라인이 user_lyrics에 한 번이면 출력도 한 번. 두 번이면 두 번. 정확히.",
    "- 불확실한 구간은 차라리 빈 채로 두기 (gap 허용). 추측 중복 금지.",
    "",
    "JSON으로만 응답하세요 (마크다운/설명 금지):",
    `{
  "aligned_segments": [
    {
      "start": 0.5,
      "end": 3.2,
      "text": "사용자 가사 한 줄",
      "section": "verse_1 | chorus | bridge | intro | outro | null"
    }
  ],
  "alignment_confidence": "high | medium | low",
  "warnings": ["sync 안 맞을 가능성 있는 구간 안내"]
}`,
  ].join("\n");
}

function buildAnalysisPrompt(args: {
  segments: WhisperSegment[] | AlignedSegment[];
  duration: number;
  isLikelyInstrumental: boolean;
  lyricsHint: string | null;
  userLyrics: string | null;
  transcriptSource: "whisper" | "user_aligned";
}): string {
  const lines: string[] = [];
  lines.push(`곡 길이: ${args.duration.toFixed(1)}초`);
  lines.push(
    `가사 소스: ${args.transcriptSource === "user_aligned" ? "사용자 제공 (정확)" : "Whisper 자동 추출 (부정확할 수 있음)"}`
  );
  if (args.isLikelyInstrumental) {
    lines.push(
      "(가사가 거의 없거나 instrumental로 추정됩니다. is_instrumental=true로 응답하세요.)"
    );
  }
  if (args.userLyrics) {
    lines.push("");
    lines.push("사용자 가사 (정확):");
    lines.push(args.userLyrics);
  } else if (args.lyricsHint) {
    lines.push("");
    lines.push("Suno 페이지 가사 힌트 (참고용):");
    lines.push(args.lyricsHint);
  }
  if (args.segments.length > 0) {
    lines.push("");
    lines.push("가사 타임스탬프:");
    for (const s of args.segments) {
      lines.push(`[${fmt(s.start)}-${fmt(s.end)}] ${s.text.trim()}`);
    }
  }
  lines.push("");
  lines.push(
    "위 정보를 바탕으로 곡을 분석해 다음 JSON 스키마로만 응답하세요.\n" +
      "마크다운 코드 펜스, 설명 텍스트 절대 금지.\n\n" +
      "{\n" +
      '  "structure": [\n' +
      '    { "section": "intro|verse|chorus|bridge|outro|interlude",\n' +
      '      "label": "Verse 1 같은 라벨",\n' +
      '      "start": 초 (number),\n' +
      '      "end": 초 (number),\n' +
      '      "lyrics_summary": "이 섹션의 가사/내용 1줄 요약" }\n' +
      "  ],\n" +
      '  "mood": "전체 무드 1-2 문장",\n' +
      '  "tempo_feel": "slow | mid | fast",\n' +
      '  "estimated_bpm": 추정 BPM (number, 모르면 null),\n' +
      '  "estimated_genre": "추정 장르",\n' +
      '  "keywords": ["핵심 키워드 5개"],\n' +
      '  "language": "ISO 코드 (ko, en, ja 등)",\n' +
      '  "is_instrumental": boolean,\n' +
      '  "emotional_arc": "기-승-전-결 한 줄 요약"\n' +
      "}\n"
  );
  return lines.join("\n");
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}
