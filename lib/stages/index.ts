import { stage as inputAnalysis } from "./01-input-analysis";
import { stage as musicAnalysis } from "./02-music-analysis";
import { stage as styleFramework } from "./03-style-framework";
import { stage as creativeBrief } from "./04-creative-brief";
import { stage as characterStyleSheet } from "./05-character-style-sheet";
import { stage as sceneMultishot } from "./06-scene-multishot";
import { stage as keyframes } from "./07-keyframes";
import { stage as videoGeneration } from "./08-video-generation";
import { stage as merge } from "./09-merge";
import type { Stage } from "../orchestrator";

export const stages: Stage[] = [
  inputAnalysis,
  musicAnalysis,
  styleFramework,
  creativeBrief,
  characterStyleSheet,
  sceneMultishot,
  keyframes,
  videoGeneration,
  merge,
];

export function stageIndex(name: string): number {
  return stages.findIndex((s) => s.name === name);
}

export function stageMeta(): Array<{ name: string; label: string }> {
  return stages.map(({ name, label }) => ({ name, label }));
}
