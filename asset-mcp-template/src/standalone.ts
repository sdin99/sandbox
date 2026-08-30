/**
 * 로컬 개발/테스트용 단독 실행 엔트리포인트.
 * (실제 통합에서는 이 파일이 아니라 기존 API 서버의 부트스트랩에
 *  attachAllMcp(app) 한 줄을 추가하는 방식 — mcp-router.ts 상단 주석 참고)
 *
 * 실행:  npm run dev
 *   → db-mcp: http://localhost:8000/mcp/db
 *   → ai-mcp: http://localhost:8000/mcp/ai
 * 검증:  npm run inspector  → Streamable HTTP로 위 URL 연결
 */

import express from "express";
import { attachAllMcp } from "./mcp-router.js";

const app = express();
attachAllMcp(app);

const port = Number(process.env.PORT ?? 8000);
app.listen(port, () => {
  console.log(`[asset-mcp] db-mcp → http://localhost:${port}/mcp/db`);
  console.log(`[asset-mcp] ai-mcp → http://localhost:${port}/mcp/ai`);
  const auth = [
    process.env.MCP_API_KEYS ? "X-Api-Key ON" : null,
    process.env.MCP_TOKEN_VERIFY_SECRET ? "JWT ON" : null,
  ].filter(Boolean).join(" + ");
  console.log("[asset-mcp] auth:", auth || "OFF (개발 모드)");
  console.log("[asset-mcp] internal AI:",
    process.env.INTERNAL_AI_URL ?? "미설정 (ai-mcp 툴은 안내 에러 반환)");
});
