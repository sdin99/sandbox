/**
 * 기존 Express 앱에 MCP 엔드포인트들을 얹는 통합 레이어.
 *
 * 기존 API 서버의 부트스트랩 코드(app 만드는 곳)에 두 줄 추가:
 *
 *     import { attachAllMcp } from "./mcp-router.js";
 *     attachAllMcp(app);
 *
 * 그러면 MCP 서버 두 개가 열린다 — 사내 AI 에이전트에 각각 등록:
 *
 *     https://<기존서버>/mcp/db   자산 DB 조회/취합/반영 (db-mcp.ts)
 *     https://<기존서버>/mcp/ai   사내 AI 위임 — DRM 해제/분석 (ai-mcp.ts)
 *
 * 하나의 프로세스에 두 MCP를 두는 이유: 공유 파일 저장소(files.ts)를 통해
 * file_id로 파일을 주고받기 위해서다. 나중에 완전히 별도 서비스로 분리한다면
 * files.ts를 공유 스토리지(NFS/오브젝트 스토리지)로 교체하면 된다.
 *
 * ─ Express가 아니라면? ─
 *   Fastify/Koa/NestJS여도 원리는 같다: POST 요청을
 *   StreamableHTTPServerTransport.handleRequest(req, res, body)에 넘기면 된다.
 *   (Node의 raw req/res가 필요하므로 Fastify는 fastify.raw, Nest는 어댑터의
 *   raw 객체를 꺼내 쓰면 됨)
 *
 * ─ 별도 포트로 열고 싶다면? ─
 *   같은 프로세스에서 express 앱을 하나 더 만들어 listen만 다른 포트로:
 *
 *     const mcpApp = express();
 *     attachAllMcp(mcpApp);
 *     mcpApp.listen(9000);   // 기존 앱은 8000, MCP는 9000
 */

import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import jwt from "jsonwebtoken";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildAiMcpServer } from "./ai-mcp.js";
import { buildDbMcpServer } from "./db-mcp.js";
import { EXPORT_DIR, startFileCleanup } from "./files.js";

// ---------------------------------------------------------------------------
// 인증 미들웨어
// ---------------------------------------------------------------------------
// 두 가지 검증을 조합해서 쓴다 (둘 다 켜면 둘 다 통과해야 함):
//
//   ① 고정 키 허용목록 (MCP_API_KEYS) — X-Api-Key 값이 "발급해둔 고정 키"일 때.
//   ② 토큰 서명 검증 (MCP_TOKEN_VERIFY_SECRET) — 값이 "서명된 JWT"일 때.
//      토큰이 실리는 헤더는 MCP_TOKEN_HEADER로 선택한다:
//        (기본)  authorization  →  Authorization: Bearer <JWT>
//        x-api-key              →  X-Api-Key: <JWT>   ← 사내 규격이 이 방식이면
//
// 사내 토큰이 "서명 검증이 불가능한 불투명(opaque) 토큰 + 만료 있음"이라면
// ①②로는 안 되고, 발급처의 토큰 검증 API를 호출해야 한다 — 그 경우 이 함수
// 안에서 fetch로 검증하고 결과를 짧게(예: 60초) 캐시하는 로직으로 교체. (TODO)
//
// 모두 미설정이면 무인증 통과(개발 모드) — 운영에서는 최소 하나 반드시 켤 것.
function mcpAuth(req: Request, res: Response, next: NextFunction) {
  // ── ① 고정 키 허용목록 ──
  const apiKeys = (process.env.MCP_API_KEYS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (apiKeys.length > 0) {
    const provided = req.headers["x-api-key"];
    if (typeof provided !== "string" || !apiKeys.includes(provided)) {
      res.status(401).json({ error: "invalid or missing X-Api-Key header" });
      return;
    }
  }

  // ── ② 토큰(JWT) 서명 검증 ──
  const secret = process.env.MCP_TOKEN_VERIFY_SECRET;
  if (!secret) {
    (req as Request & { mcpActor?: string }).mcpActor =
      apiKeys.length > 0 ? "mcp-apikey" : "mcp-anonymous(dev)";
    return next();
  }

  const tokenHeader = (process.env.MCP_TOKEN_HEADER ?? "authorization").toLowerCase();
  const raw = req.headers[tokenHeader];
  // "Bearer " 접두사는 있어도 없어도 허용 — X-Api-Key에는 보통 토큰만 실린다
  const token =
    typeof raw === "string" && raw
      ? (raw.startsWith("Bearer ") ? raw.slice(7) : raw)
      : null;
  if (!token) {
    // MCP 스펙: 401에는 WWW-Authenticate 헤더를 실어주는 것이 권장됨
    res.status(401).set("WWW-Authenticate", "Bearer")
      .json({ error: `missing token in ${tokenHeader} header` });
    return;
  }
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      audience: process.env.MCP_TOKEN_AUDIENCE ?? "asset-mcp",
      issuer: process.env.MCP_TOKEN_ISSUER, // 미설정 시 issuer 검증 생략
    }) as jwt.JwtPayload;
    // 감사 로그에 남길 호출 주체 — sub(사용자) 우선, 없으면 client_id
    (req as Request & { mcpActor?: string }).mcpActor =
      payload.sub ?? (payload.client_id as string | undefined) ?? "mcp-unknown";
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}

// ---------------------------------------------------------------------------
// MCP 엔드포인트 공통 배선
// ---------------------------------------------------------------------------
/** basePath에 MCP 서버 하나를 stateless 모드로 연결한다. */
function attachMcpEndpoint(
  app: Express,
  basePath: string,
  buildServer: (actor: string) => McpServer,
): void {
  // MCP는 JSON body를 쓴다. base64 파일 업로드 때문에 limit을 넉넉히.
  app.use(basePath, express.json({ limit: "50mb" }));

  // ── stateless 모드 ──
  // 요청마다 서버/트랜스포트를 새로 만들고 끝나면 버린다. 세션 상태가 없어서
  // 인스턴스 여러 개로 스케일아웃하거나 재배포해도 에이전트 연결이 안 깨진다.
  // (SDK 공식 문서의 "stateless" 패턴 그대로)
  app.post(basePath, mcpAuth, async (req: Request, res: Response) => {
    const actor = (req as Request & { mcpActor?: string }).mcpActor ?? "mcp-unknown";
    try {
      const server = buildServer(actor);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // undefined = stateless
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(`[asset-mcp] ${basePath} request failed:`, e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal server error" },
          id: null,
        });
      }
    }
  });

  // stateless 모드에서는 GET(SSE 알림 스트림)/DELETE(세션 종료)를 지원하지 않음
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed in stateless mode" },
      id: null,
    });
  };
  app.get(basePath, methodNotAllowed);
  app.delete(basePath, methodNotAllowed);
}

// ---------------------------------------------------------------------------
// 전체 mount
// ---------------------------------------------------------------------------
export function attachAllMcp(app: Express): void {
  attachMcpEndpoint(app, "/mcp/db", buildDbMcpServer); // 자산 DB MCP
  attachMcpEndpoint(app, "/mcp/ai", buildAiMcpServer); // 사내 AI 위임 MCP

  // ── 파일 다운로드 라우트 (두 MCP 공용) ──
  // 툴이 만든 파일(export 엑셀, DRM 해제본, 분석 결과)을 서빙.
  // 파일명에 랜덤 토큰이 들어있지만, 자산 데이터 + DRM 해제본은 민감하므로
  // 운영에서는 반드시 사내 인증(세션/SSO 쿠키 등)을 붙일 것.
  // (에이전트가 URL을 사용자에게 전달 → 사용자가 브라우저로 받는 흐름이므로,
  //  브라우저에서 통하는 인증이어야 함)
  app.use("/mcp-downloads", express.static(EXPORT_DIR, { fallthrough: false }));

  // ── 파일 TTL 정리 스위퍼 ──
  // DRM 해제본은 4시간, 그 외는 24시간 보관 후 삭제 (env로 조정 — files.ts 참고)
  startFileCleanup();
}
