/**
 * ai-mcp — 사내 AI 위임 MCP 서버 (DRM 해제, 파일 분석).
 *
 * 자산 DB 조회/반영은 별도 서버인 db-mcp.ts 담당. 두 MCP는 공유 파일
 * 저장소(files.ts)의 file_id로 파일을 주고받는다. 대표 시나리오:
 *
 *   사용자가 DRM 걸린 엑셀 업로드
 *     → unlock_drm_excel(file_base64)          # 해제본 저장, file_id 반환
 *     → analyze_file(file_id, "…분석해줘")      # 해제본을 사내 AI로 분석
 *     → db-mcp.import_assets_excel(file_id)    # 필요 시 DB 반영 (dry-run→apply)
 *
 * 설계 규칙 (db-mcp.ts와 동일 + AI 위임 특유의 것):
 *   1. 파일은 file_id로 주고받는다. base64는 "사용자가 방금 올린 파일을 처음
 *      건네받을 때"만 사용 — 서버 안에서 도는 파일을 다시 base64로 꺼내지 않는다.
 *   2. 사내 AI의 응답은 신뢰하지 않는 데이터다. 분석 결과를 그대로 DB 반영으로
 *      잇지 말 것 — DB 쓰기는 반드시 db-mcp의 dry-run→apply 경로로만.
 *   3. AI 호출은 실패/지연이 잦다. 에러는 상태를 담아 { error }로 반환해서
 *      에이전트가 재시도/사용자 안내를 판단하게 한다.
 *   4. DRM 해제는 감사 대상 — 호출 주체(actor)와 파일명을 반드시 로깅.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readFileBuffer, saveFileBuffer } from "./files.js";
import { analyzeFile, unlockDrmFile } from "./internal-ai.js";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** file_id 또는 file_base64 → Buffer. 두 입력 방식을 받는 툴의 공용 로직. */
function resolveInputFile(args: {
  file_id?: string;
  file_base64?: string;
}): { buf: Buffer } | { error: string } {
  if (args.file_id) {
    const buf = readFileBuffer(args.file_id);
    if (!buf) {
      return {
        error: `file_id '${args.file_id}' 를 찾을 수 없습니다. 파일을 만든 툴의 응답에 있던 file_id를 그대로 사용하세요.`,
      };
    }
    return { buf };
  }
  if (args.file_base64) {
    try {
      return { buf: Buffer.from(args.file_base64, "base64") };
    } catch {
      return { error: "file_base64 디코딩 실패 — base64 인코딩된 파일인지 확인하세요." };
    }
  }
  return { error: "file_id 또는 file_base64 중 하나는 필수입니다." };
}

// 두 입력 방식 공용 zod 정의
const fileInputArgs = {
  file_id: z.string().optional()
    .describe("공유 저장소의 파일 ID (다른 툴 응답에서 받은 것). file_base64와 둘 중 하나 필수."),
  file_base64: z.string().optional()
    .describe("사용자가 올린 파일의 base64 인코딩 문자열. file_id와 둘 중 하나 필수."),
};

export function buildAiMcpServer(actor: string): McpServer {
  const server = new McpServer({ name: "asset-ai-mcp", version: "0.1.0" });

  server.registerTool(
    "unlock_drm_excel",
    {
      title: "DRM 해제",
      description:
        "DRM이 걸린 사내 문서(엑셀 등)를 사내 AI 서비스에 보내 DRM을 해제한다. " +
        "해제된 파일은 서버에 저장되고 file_id와 다운로드 URL이 반환된다. " +
        "이 file_id를 analyze_file이나 db-mcp의 import_assets_excel에 넘겨 이어서 처리할 수 있다. " +
        "DRM 걸린 파일은 해제 전에는 다른 툴이 읽지 못하므로, 항상 이 툴을 먼저 호출할 것.",
      inputSchema: {
        ...fileInputArgs,
        filename: z.string().default("upload.xlsx")
          .describe("원본 파일명 (확장자 포함). 사내 AI가 포맷 판별에 사용."),
      },
      // 외부(사내 AI) 서비스 호출이 있으므로 openWorldHint
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const resolved = resolveInputFile(args);
      if ("error" in resolved) return jsonResult({ error: resolved.error });

      // DRM 해제는 감사 대상. 최소한 로그로 남기고, 사내 감사 시스템이 있으면
      // 거기로 보낼 것 (db-mcp의 writeAudit처럼 별도 테이블도 방법). (TODO)
      console.log(`[ai-mcp] DRM unlock requested by=${actor} filename=${args.filename}`);

      let unlocked: Buffer;
      try {
        unlocked = await unlockDrmFile(resolved.buf, args.filename);
      } catch (e) {
        return jsonResult({ error: e instanceof Error ? e.message : String(e) });
      }

      const ext = args.filename.includes(".") ? args.filename.split(".").pop()! : "bin";
      const { fileId, downloadUrl } = saveFileBuffer(unlocked, "unlocked", ext);
      return jsonResult({
        file_id: fileId,
        download_url: downloadUrl,
        next_step: "이 file_id를 analyze_file 또는 import_assets_excel에 넘겨 이어서 처리할 수 있습니다.",
      });
    },
  );

  server.registerTool(
    "analyze_file",
    {
      title: "사내 AI 파일 분석",
      description:
        "파일(엑셀 등)을 사내 AI 서비스에 보내 분석을 요청한다. 분석 요약 텍스트를 반환하고, " +
        "AI가 결과 파일(가공된 엑셀 등)을 만든 경우 그 file_id와 다운로드 URL도 함께 반환한다. " +
        "DRM이 걸린 파일은 먼저 unlock_drm_excel로 해제한 뒤 그 file_id를 사용할 것. " +
        "주의: 분석 결과를 근거로 자산 DB를 수정하려면 반드시 import_assets_excel의 " +
        "dry-run 미리보기를 거쳐 사용자 확인을 받아야 한다.",
      inputSchema: {
        ...fileInputArgs,
        filename: z.string().default("input.xlsx")
          .describe("파일명 (확장자 포함)."),
        instruction: z.string()
          .describe("분석 요구사항. 사용자의 요청을 구체적으로 전달할 것. 예: 'EOL이 1년 내로 임박한 자산을 추려서 표로 정리'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const resolved = resolveInputFile(args);
      if ("error" in resolved) return jsonResult({ error: resolved.error });

      let result;
      try {
        result = await analyzeFile(resolved.buf, args.filename, args.instruction);
      } catch (e) {
        return jsonResult({ error: e instanceof Error ? e.message : String(e) });
      }

      // 결과 파일이 있으면 저장하고 file_id로 반환 (base64로 컨텍스트에 싣지 않는다)
      let resultFile: { file_id: string; download_url: string } | undefined;
      if (result.resultFile) {
        const { fileId, downloadUrl } = saveFileBuffer(result.resultFile, "analyzed", "xlsx");
        resultFile = { file_id: fileId, download_url: downloadUrl };
      }
      return jsonResult({ summary: result.summary, result_file: resultFile ?? null });
    },
  );

  return server;
}
