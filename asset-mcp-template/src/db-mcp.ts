/**
 * db-mcp — 자산 DB 조회/취합/반영 MCP 서버 (공식 TypeScript SDK).
 *
 * 사내 AI 위임(DRM 해제/분석)은 별도 서버인 ai-mcp.ts 담당. 두 MCP는
 * 공유 파일 저장소(files.ts)의 file_id로 파일을 주고받는다:
 *   ai-mcp.unlock_drm_excel → file_id → db-mcp.import_assets_excel(file_id)
 *
 * 툴 구성 (읽기 4 + 쓰기 2):
 *
 *   [읽기] list_assets           자산 목록 조회 (필터 + 페이지네이션)
 *          get_asset             자산 1건 상세
 *          asset_summary         집계 (타입별/부서별/상태별 카운트)
 *          export_assets_excel   조회 결과를 엑셀로 만들어 다운로드 URL 반환
 *   [쓰기] import_assets_excel   엑셀 업로드 → dry-run 미리보기 → apply=true 시 반영
 *          update_asset          자산 1건 필드 수정 (감사 로그 기록)
 *
 * 설계 규칙 — 새 툴을 추가할 때도 지킬 것:
 *   1. 응답은 항상 "요약된 객체". DB row를 통째로 돌려주지 않는다.
 *      에이전트의 컨텍스트는 비싸다.
 *   2. 목록 툴은 반드시 필터 + 페이지네이션. "전체 덤프" 툴은 만들지 않는다.
 *   3. 쓰기 툴은 destructiveHint 어노테이션 + 감사 로그 + (대량이면) dry-run 2단계.
 *   4. 에러도 throw하지 말고 { error: "...다음 행동 안내..." }로 반환 —
 *      에이전트가 읽고 스스로 복구하게 만든다.
 *      나쁨: "not found" / 좋음: "id=3 없음. list_assets로 먼저 확인하세요."
 *   5. description이 곧 에이전트가 읽는 툴 설명서다. 인자 설명을 생략하지 말 것.
 *   6. 임의 SQL 툴(run_sql 등)은 만들지 않는다 — 인젝션/권한 문제의 온상.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  ASSET_TYPES,
  WRITABLE_FIELDS,
  type Asset,
  type AssetFilter,
  getAssetById,
  insertAsset,
  listAssets,
  summarizeAssets,
  updateAsset,
  writeAudit,
} from "./db.js";
import { readXlsxBase64, writeRowsToXlsx } from "./excel.js";
import { readFileBuffer } from "./files.js";

const MAX_PAGE_SIZE = 200;

/** 툴 응답 공통 포맷: JSON을 text로 직렬화해서 반환.
 *  (outputSchema + structuredContent를 추가로 정의하면 클라이언트가 구조를
 *   더 잘 활용하지만, 우선은 단순하게 시작 — 필요 시 툴별로 추가) */
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Asset → 에이전트에게 돌려줄 요약 객체. 컬럼 추가 시 여기 한 곳만 수정. */
function assetRow(a: Asset) {
  return {
    id: a.id,
    asset_type: a.assetType,
    name: a.name,
    owner_team: a.ownerTeam,
    location: a.location,
    vendor: a.vendor,
    model: a.model,
    status: a.status,
    eol_date: a.eolDate,
  };
}

// 목록/집계/엑셀 툴이 공유하는 필터 인자 정의 — zod 스키마도 한 곳에서 관리
const filterArgs = {
  asset_type: z.enum(ASSET_TYPES).optional()
    .describe("자산 타입 필터. HW | WAS | DB | SAP | SW. 미지정 시 전체."),
  keyword: z.string().optional()
    .describe("자산명/모델/벤더 부분 일치 검색어."),
  status: z.string().optional()
    .describe("자산 상태 필터 (예: active, retired)."),
};

function toFilter(args: { asset_type?: string; keyword?: string; status?: string }): AssetFilter {
  return {
    assetType: args.asset_type as AssetFilter["assetType"],
    keyword: args.keyword,
    status: args.status,
  };
}

/**
 * MCP 서버 빌드. stateless HTTP 모드에서는 요청마다 새로 만드는 게 SDK 권장
 * 패턴이라 함수로 감쌌다 (mcp-router.ts 참고).
 *
 * @param actor 감사 로그에 남길 호출 주체 — 인증 미들웨어가 JWT에서 뽑아 넘긴다.
 */
export function buildDbMcpServer(actor: string): McpServer {
  const server = new McpServer({ name: "asset-db-mcp", version: "0.1.0" });

  // -------------------------------------------------------------------------
  // 읽기 툴
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_assets",
    {
      title: "자산 목록 조회",
      description:
        "자산 목록을 조회한다. 필터(타입/키워드/상태)와 페이지네이션 지원. " +
        "결과의 has_more가 true면 page를 올려 다음 페이지를 조회할 것.",
      inputSchema: {
        ...filterArgs,
        page: z.number().int().min(1).default(1).describe("1부터 시작하는 페이지 번호."),
        page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50)
          .describe(`페이지당 건수 (최대 ${MAX_PAGE_SIZE}).`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { total, items } = await listAssets(toFilter(args), args.page, args.page_size);
      return jsonResult({
        total,
        page: args.page,
        page_size: args.page_size,
        has_more: args.page * args.page_size < total,
        assets: items.map(assetRow),
      });
    },
  );

  server.registerTool(
    "get_asset",
    {
      title: "자산 상세 조회",
      description: "자산 1건의 상세 정보를 조회한다. ID를 모르면 list_assets로 먼저 검색.",
      inputSchema: {
        asset_id: z.number().int().describe("자산 ID."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ asset_id }) => {
      const a = await getAssetById(asset_id);
      if (!a) {
        return jsonResult({
          error: `자산 id=${asset_id} 없음. list_assets(keyword=...)로 먼저 ID를 확인하세요.`,
        });
      }
      return jsonResult(assetRow(a));
    },
  );

  server.registerTool(
    "asset_summary",
    {
      title: "자산 집계",
      description:
        "자산을 기준 컬럼으로 집계한다. '부서별 자산 몇 개?', '타입별 현황' 류 질문에 사용.",
      inputSchema: {
        group_by: z.enum(["assetType", "ownerTeam", "location", "vendor", "status"])
          .default("assetType")
          .describe("집계 기준 컬럼."),
        asset_type: filterArgs.asset_type,
        status: filterArgs.status,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      // group_by는 z.enum으로 이미 화이트리스트 검증됨 — 임의 컬럼 주입 불가
      const buckets = await summarizeAssets(args.group_by, toFilter(args));
      return jsonResult({ group_by: args.group_by, buckets });
    },
  );

  server.registerTool(
    "export_assets_excel",
    {
      title: "자산 엑셀 다운로드 생성",
      description:
        "조회 조건에 맞는 자산 목록을 엑셀(.xlsx)로 생성하고 다운로드 URL을 반환한다. " +
        "'~~ 목록 엑셀로 만들어줘' 요청에 사용. 파일 내용은 반환하지 않으므로 " +
        "사용자에게 download_url을 전달하면 된다. 반환되는 file_id는 " +
        "ai-mcp의 analyze_file 등 다른 툴에 그대로 넘겨 이어서 처리할 수 있다.",
      inputSchema: { ...filterArgs },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      // 엑셀은 페이지네이션 없이 전량 — 단, 상한을 둬서 폭주 방지
      const { total, items } = await listAssets(toFilter(args), 1, 10_000);
      if (items.length === 0) {
        return jsonResult({ error: "조건에 맞는 자산이 없어 엑셀을 만들지 않았습니다. 필터를 완화해 보세요." });
      }
      // 컬럼 구성은 import_assets_excel의 header_map과 짝을 맞춰 유지할 것
      const headers = ["ID", "타입", "자산명", "담당부서", "위치", "벤더", "모델", "상태", "EOL"];
      const rows = items.map((a) => [
        a.id, a.assetType, a.name, a.ownerTeam, a.location, a.vendor, a.model, a.status, a.eolDate,
      ]);
      const { fileId, downloadUrl } = await writeRowsToXlsx(headers, rows);
      return jsonResult({ row_count: total, file_id: fileId, download_url: downloadUrl });
    },
  );

  // -------------------------------------------------------------------------
  // 쓰기 툴
  // -------------------------------------------------------------------------
  server.registerTool(
    "update_asset",
    {
      title: "자산 정보 수정",
      description:
        "자산 1건의 필드를 수정한다. 변경 전/후가 감사 로그에 기록된다. " +
        `허용 필드: ${WRITABLE_FIELDS.join(", ")}`,
      inputSchema: {
        asset_id: z.number().int().describe("수정할 자산 ID."),
        fields: z.record(z.string(), z.union([z.string(), z.null()]))
          .describe(
            '수정할 필드와 값. 예: {"ownerTeam": "인프라운영팀", "status": "retired"}',
          ),
        reason: z.string().describe("변경 사유 (감사 로그용). 사용자 요청을 요약해서 넣을 것."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ asset_id, fields, reason }) => {
      const bad = Object.keys(fields).filter(
        (k) => !(WRITABLE_FIELDS as readonly string[]).includes(k),
      );
      if (bad.length) {
        return jsonResult({ error: `수정 불가 필드: ${bad.join(", ")}. 허용: ${WRITABLE_FIELDS.join(", ")}` });
      }
      if (Object.keys(fields).length === 0) {
        return jsonResult({ error: "fields가 비어 있습니다. 수정할 필드와 값을 지정하세요." });
      }

      const before = await getAssetById(asset_id);
      if (!before) {
        return jsonResult({ error: `자산 id=${asset_id} 없음. list_assets로 먼저 확인하세요.` });
      }

      const updated = await updateAsset(asset_id, fields as Partial<Asset>);
      await writeAudit({
        assetId: asset_id,
        actor,
        action: "update",
        detail: { before: assetRow(before), after: fields },
        reason,
      });
      return jsonResult({
        updated: true,
        asset: updated ? assetRow(updated) : null,
        changed_fields: Object.keys(fields),
      });
    },
  );

  server.registerTool(
    "import_assets_excel",
    {
      title: "엑셀 업로드로 자산 일괄 반영",
      description:
        "엑셀 업로드로 자산을 일괄 등록/수정한다. 반드시 2단계로 사용할 것: " +
        "(1) apply=false(기본)로 호출하면 무엇이 어떻게 바뀔지 미리보기만 반환하고 DB는 건드리지 않는다 — " +
        "미리보기를 사용자에게 보여주고 확인받을 것. (2) 사용자가 확인하면 같은 파일로 apply=true 재호출 시 실제 반영. " +
        "파일은 file_id(다른 툴이 반환한 것 — 예: ai-mcp unlock_drm_excel의 해제본) 또는 " +
        "file_base64(사용자가 직접 올린 파일) 중 하나로 전달. " +
        "엑셀 형식: 1행 헤더, 'ID' 값이 있으면 해당 자산 수정 / 비어 있으면 신규 등록. " +
        "헤더는 export_assets_excel 출력과 동일(타입/자산명/담당부서/위치/벤더/모델/상태).",
      inputSchema: {
        file_id: z.string().optional()
          .describe("공유 저장소의 파일 ID (다른 툴의 응답에서 받은 것). file_base64와 둘 중 하나 필수."),
        file_base64: z.string().optional()
          .describe(".xlsx 파일의 base64 인코딩 문자열. file_id와 둘 중 하나 필수."),
        apply: z.boolean().default(false)
          .describe("false면 dry-run(미리보기), true면 실제 DB 반영."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ file_id, file_base64, apply }) => {
      // file_id 우선 — 서버 안에서만 파일이 흐르므로 컨텍스트 낭비가 없다
      if (file_id) {
        const buf = readFileBuffer(file_id);
        if (!buf) {
          return jsonResult({
            error: `file_id '${file_id}' 를 찾을 수 없습니다. 파일을 만든 툴의 응답에 있던 file_id를 그대로 사용하세요.`,
          });
        }
        file_base64 = buf.toString("base64");
      }
      if (!file_base64) {
        return jsonResult({ error: "file_id 또는 file_base64 중 하나는 필수입니다." });
      }
      // 한국어 헤더 → DB 컬럼 매핑 (TODO: 사내 양식에 맞게 조정)
      const headerMap: Record<string, keyof Asset> = {
        타입: "assetType", 자산명: "name", 담당부서: "ownerTeam",
        위치: "location", 벤더: "vendor", 모델: "model", 상태: "status",
      };

      let records;
      try {
        records = await readXlsxBase64(file_base64);
      } catch (e) {
        return jsonResult({ error: String(e instanceof Error ? e.message : e) });
      }
      if (records.length === 0) return jsonResult({ error: "엑셀에 데이터 행이 없습니다." });

      const creates: Array<Partial<Asset>> = [];
      const updates: Array<{ id: number; name: string; diff: Record<string, unknown> }> = [];
      const errors: string[] = [];

      // 1차 패스: 검증 + diff 계산만. 실제 쓰기는 검증 전체 통과 후에만 —
      // 부분 반영은 취합 데이터를 망가뜨리므로 오류가 하나라도 있으면 전체 중단.
      for (const [i, rec] of records.entries()) {
        const rowNo = i + 2; // 엑셀 행 번호(1행은 헤더)
        const fields: Partial<Asset> = {};
        for (const [xlsCol, dbCol] of Object.entries(headerMap)) {
          const v = rec[xlsCol];
          if (v != null) (fields as Record<string, unknown>)[dbCol] = String(v);
        }

        if (fields.assetType && !(ASSET_TYPES as readonly string[]).includes(fields.assetType)) {
          errors.push(`${rowNo}행: 타입 '${fields.assetType}' 은 유효하지 않음 (${ASSET_TYPES.join("/")})`);
          continue;
        }

        const rawId = rec["ID"];
        if (rawId != null && rawId !== "") {
          const existing = await getAssetById(Number(rawId));
          if (!existing) { errors.push(`${rowNo}행: ID=${rawId} 자산 없음`); continue; }
          const existingRec = existing as unknown as Record<string, unknown>;
          const diff: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(fields)) {
            if (existingRec[k] !== v) {
              diff[k] = { before: existingRec[k], after: v };
            }
          }
          if (Object.keys(diff).length === 0) continue; // 변경 없음 — 노이즈 제거
          updates.push({ id: existing.id, name: existing.name, diff });
        } else {
          if (!fields.name || !fields.assetType) {
            errors.push(`${rowNo}행: 신규 등록에는 '자산명'과 '타입'이 필수`);
            continue;
          }
          creates.push(fields);
        }
      }

      if (apply && errors.length > 0) {
        return jsonResult({
          applied: false,
          error: "검증 오류가 있어 아무것도 반영하지 않았습니다. 오류를 수정 후 다시 업로드하세요.",
          errors,
        });
      }

      // 2차 패스: 실제 반영 (apply=true이고 오류 0건일 때만)
      // TODO: 실제 DB에서는 이 블록을 트랜잭션(BEGIN/COMMIT)으로 감쌀 것.
      if (apply) {
        for (const u of updates) {
          const fields = Object.fromEntries(
            Object.entries(u.diff).map(([k, v]) => [k, (v as { after: unknown }).after]),
          );
          await updateAsset(u.id, fields as Partial<Asset>);
        }
        for (const c of creates) {
          await insertAsset({
            assetType: c.assetType!, name: c.name!,
            ownerTeam: c.ownerTeam ?? null, location: c.location ?? null,
            vendor: c.vendor ?? null, model: c.model ?? null,
            status: c.status ?? "active", eolDate: c.eolDate ?? null,
          });
        }
        await writeAudit({
          assetId: null, actor, action: "excel_import",
          detail: { creates: creates.length, updates: updates.length },
          reason: "excel import via MCP",
        });
      }

      return jsonResult({
        applied: apply,
        create_count: creates.length,
        update_count: updates.length,
        errors,
        // 미리보기는 앞쪽 일부만 — 컨텍스트 절약. 전체 규모는 카운트로 판단.
        creates_preview: creates.slice(0, 20),
        updates_preview: updates.slice(0, 20),
        ...(apply ? {} : {
          next_step: "미리보기를 사용자에게 확인받은 뒤, 같은 파일로 apply=true 재호출하면 반영됩니다.",
        }),
      });
    },
  );

  return server;
}
