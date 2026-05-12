/**
 * API 키 + 시스템 의존성 사전 검증 (API 무호출, 비용 0원).
 *
 *   npm run check-env
 *
 * Exit 0: 모두 통과
 * Exit 1: 하나 이상 실패 — 메시지 보고 .env.local / 시스템 점검
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "FAL_KEY",
];

const OPTIONAL_KEYS = [
  "FAL_VIDEO_MODEL",
  "FAL_PRICE_PER_SEC_KRW",
  "MAX_BUDGET_KRW",
  "MAX_SCENES",
  "IMAGE_HOST_MODE",
  "NEXT_PUBLIC_BASE_URL",
];

type Check = { name: string; ok: boolean; detail?: string; warning?: boolean };
const checks: Check[] = [];

function add(c: Check) {
  checks.push(c);
}

// 1) .env.local 로드 (Next.js가 dev 시 자동 로드하지만 이 스크립트는 standalone)
loadDotenv(path.join(process.cwd(), ".env.local"));

// 2) 필수 키 존재 + 형식
for (const k of REQUIRED_KEYS) {
  const v = process.env[k];
  if (!v) {
    add({ name: k, ok: false, detail: "(빈 값)" });
    continue;
  }
  let detail = `${v.slice(0, 8)}***`;
  // 키 형식 sanity check (실제 호출 X)
  if (k === "ANTHROPIC_API_KEY" && !v.startsWith("sk-ant-")) {
    add({
      name: k,
      ok: false,
      detail: `${detail} — 'sk-ant-'로 시작해야 함`,
    });
    continue;
  }
  if (k === "OPENAI_API_KEY" && !v.startsWith("sk-")) {
    add({
      name: k,
      ok: false,
      detail: `${detail} — 'sk-'로 시작해야 함`,
    });
    continue;
  }
  add({ name: k, ok: true, detail });
}

// 3) 선택 키 표시
for (const k of OPTIONAL_KEYS) {
  const v = process.env[k];
  add({
    name: k,
    ok: true,
    detail: v ? v : "(미설정)",
    warning: !v,
  });
}

// 4) ffmpeg / ffprobe 가용성
add(checkBin("ffmpeg"));
add(checkBin("ffprobe"));

// 5) IMAGE_HOST_MODE 정보 표시 (fal.ai는 자체 storage 사용해서 BytePlus 같은 제약 없음)
{
  const mode = process.env.IMAGE_HOST_MODE ?? "data_uri";
  add({
    name: "IMAGE_HOST_MODE",
    ok: true,
    detail: `${mode} — fal.ai는 자체 storage 업로드 사용 (영상은 외부 URL 불필요)`,
  });
}

// 6) DB 디렉터리 쓰기 권한
{
  const ws = path.join(process.cwd(), "workspace");
  try {
    fs.mkdirSync(ws, { recursive: true });
    const probe = path.join(ws, ".write-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    add({ name: "workspace/ 쓰기 권한", ok: true, detail: ws });
  } catch (e) {
    add({
      name: "workspace/ 쓰기 권한",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

// 출력
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

console.log("\n사전 검증 결과 (API 무호출, 비용 0원)\n");
let failed = 0;
let warned = 0;
for (const c of checks) {
  const icon = c.ok ? (c.warning ? `${YELLOW}⚠${RESET}` : `${GREEN}✓${RESET}`) : `${RED}✗${RESET}`;
  const name = c.name.padEnd(34, " ");
  console.log(`  ${icon}  ${name}${c.detail ? ` ${c.detail}` : ""}`);
  if (!c.ok) failed++;
  if (c.warning) warned++;
}
console.log("");
if (failed > 0) {
  console.log(`${RED}${failed}개 실패 — .env.local과 시스템 설정 확인하세요.${RESET}`);
  process.exit(1);
}
if (warned > 0) {
  console.log(`${YELLOW}${warned}개 경고 — 사용 환경에 따라 문제가 될 수 있습니다.${RESET}`);
}
console.log(`${GREEN}모든 필수 검증 통과. npm run dev로 시작하세요.${RESET}\n`);
process.exit(0);

// ============ 헬퍼 ============

function checkBin(bin: string): Check {
  const res = spawnSync(bin, ["-version"], { stdio: "ignore" });
  if (res.error) {
    return {
      name: bin,
      ok: false,
      detail: "PATH에 없음. winget install ffmpeg 또는 brew install ffmpeg",
    };
  }
  if (res.status !== 0) {
    return { name: bin, ok: false, detail: `exit ${res.status}` };
  }
  return { name: bin, ok: true, detail: "PATH OK" };
}

function loadDotenv(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
