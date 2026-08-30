/**
 * 다른 사내 AI 서비스의 HTTP 클라이언트.
 *
 * ★ 여기의 엔드포인트/요청 형식은 전부 가정이다. 실제 사내 AI의 API 스펙
 *   (URL, 인증 방식, multipart냐 base64 JSON이냐, 동기냐 job 폴링이냐)을
 *   확인해서 각 함수 본문을 교체할 것. ai-mcp.ts(툴 정의)는 이 파일의
 *   시그니처만 알기 때문에, API 스펙 반영은 이 파일 안에서 끝난다.
 *
 * 미설정 시(INTERNAL_AI_URL 없음) 모든 함수가 안내 메시지와 함께 throw —
 * 툴 쪽에서 { error } 응답으로 변환되므로 에이전트가 상황을 알 수 있다.
 */

const AI_URL = process.env.INTERNAL_AI_URL; // 예: https://ai.corp.example.com/api
const AI_TOKEN = process.env.INTERNAL_AI_TOKEN;

/** LLM/문서 처리는 오래 걸릴 수 있다. 이걸 넘길 작업이면 툴을 job 패턴
 *  (start → status 폴링)으로 쪼갤 것 — README '설계 원칙' 참고. */
const TIMEOUT_MS = Number(process.env.INTERNAL_AI_TIMEOUT_MS ?? 120_000);

function ensureConfigured(): void {
  if (!AI_URL) {
    throw new Error(
      "사내 AI 연동이 설정되지 않았습니다 (INTERNAL_AI_URL 미설정). 관리자에게 문의하세요.",
    );
  }
}

async function post(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`${AI_URL}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(AI_TOKEN ? { Authorization: `Bearer ${AI_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    // 에이전트가 읽고 판단할 수 있는 에러로 — 상태코드까지 노출
    throw new Error(`사내 AI 호출 실패 (HTTP ${resp.status}). 잠시 후 재시도하거나 관리자에게 문의하세요.`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * DRM 해제. 원본 파일을 보내고 해제된 파일을 돌려받는다.
 *
 * 보안 메모: DRM 해제는 사내 정책상 반드시 감사 대상이다. 호출부(ai-mcp.ts)에서
 * 누가/언제/어떤 파일을 해제했는지 로그를 남기고 있는지 확인할 것.
 */
export async function unlockDrmFile(file: Buffer, filename: string): Promise<Buffer> {
  ensureConfigured();
  // TODO: 실제 DRM 해제 API 스펙으로 교체 (multipart 업로드라면 FormData 사용)
  const json = await post("/drm/unlock", {
    filename,
    file_base64: file.toString("base64"),
  });
  if (typeof json.file_base64 !== "string") {
    throw new Error("사내 AI의 DRM 해제 응답에 파일이 없습니다. API 스펙 변경 여부를 확인하세요.");
  }
  return Buffer.from(json.file_base64, "base64");
}

/**
 * 파일 분석. 분석 요약(텍스트)과, AI가 결과 파일을 만들어준 경우 그 파일도 반환.
 */
export async function analyzeFile(
  file: Buffer,
  filename: string,
  instruction: string,
): Promise<{ summary: string; resultFile?: Buffer }> {
  ensureConfigured();
  // TODO: 실제 분석 API 스펙으로 교체
  const json = await post("/analyze", {
    filename,
    file_base64: file.toString("base64"),
    instruction,
  });
  return {
    summary: typeof json.summary === "string" ? json.summary : JSON.stringify(json),
    resultFile:
      typeof json.result_file_base64 === "string"
        ? Buffer.from(json.result_file_base64, "base64")
        : undefined,
  };
}
