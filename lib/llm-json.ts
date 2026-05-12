/**
 * LLM 응답에서 JSON을 안전하게 파싱.
 * Claude가 응답을 ```json ... ``` markdown fence로 감싸거나 앞뒤 설명 텍스트를
 * 붙이는 경우가 잦아서, 그런 경우를 모두 흡수.
 */
export function parseLlmJson<T = unknown>(text: string): T {
  const cleaned = stripFences(text).trim();
  // 빠른 경로: 그대로 파싱
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // 폴백: 첫 { 또는 [ 부터 마지막 } 또는 ] 까지 추출
    const extracted = extractFirstJson(cleaned);
    if (extracted) {
      return JSON.parse(extracted) as T;
    }
    throw new Error(
      `LLM 응답을 JSON으로 파싱할 수 없습니다:\n${truncate(text, 500)}`
    );
  }
}

function stripFences(s: string): string {
  // ```json ... ``` 또는 ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fence ? fence[1] : s;
}

function extractFirstJson(s: string): string | null {
  const objStart = s.indexOf("{");
  const arrStart = s.indexOf("[");
  const start =
    objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "...";
}
