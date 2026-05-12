// Claude (claude-sonnet-4-6) — 기획 LLM 래퍼.
// 실제 호출은 프롬프트 3 이후 단계에서 구현.
import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY 환경변수가 없습니다");
  _client = new Anthropic({ apiKey });
  return _client;
}

export const CLAUDE_MODEL = "claude-sonnet-4-6";
