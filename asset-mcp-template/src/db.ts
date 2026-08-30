/**
 * DB 접근 레이어(DAO) — 템플릿용 placeholder.
 *
 * ★ 실제 통합 시: 이 파일의 in-memory 구현을 지우고, 기존 API 서버가 쓰는
 *   DB 클라이언트(mysql2 / pg / knex / prisma / typeorm 등)로 각 함수의 본문만
 *   갈아끼우면 된다. 툴 코드(server.ts)는 이 파일의 함수 시그니처만 알기 때문에
 *   DB 교체가 여기 한 파일에서 끝난다 — 이 경계를 유지할 것.
 *
 * 스키마 가정: HW / SW(WAS, DB, SAP) 자산을 한 테이블 + assetType 컬럼으로 표현.
 * 실제 스키마가 테이블 분리형이면 이 레이어에서 합쳐서(UNION/조인) 같은 모양으로
 * 노출하는 것도 방법이다.
 */

// ---------------------------------------------------------------------------
// 타입 정의 — 실제 컬럼에 맞게 수정 (TODO)
// ---------------------------------------------------------------------------
export const ASSET_TYPES = ["HW", "WAS", "DB", "SAP", "SW"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export interface Asset {
  id: number;
  assetType: AssetType;
  name: string; // 자산명/호스트명
  ownerTeam: string | null; // 담당 부서
  location: string | null; // IDC/존
  vendor: string | null; // 제조사/벤더
  model: string | null; // 모델명/버전
  status: string; // active | retired | ...
  eolDate: string | null; // EOL/EOS (ISO date)
}

/** update/import에서 수정을 허용하는 컬럼 화이트리스트.
 *  id, updatedAt 같은 시스템 컬럼이 절대 들어가면 안 된다. */
export const WRITABLE_FIELDS = [
  "assetType",
  "name",
  "ownerTeam",
  "location",
  "vendor",
  "model",
  "status",
  "eolDate",
] as const;

export interface AssetFilter {
  assetType?: AssetType;
  status?: string;
  keyword?: string; // 자산명/모델/벤더 부분 일치
}

// ---------------------------------------------------------------------------
// in-memory 데모 저장소 — Inspector로 바로 테스트해 볼 수 있게 넣어둔 것.
// 실제 DB 연결로 교체하면서 통째로 삭제. (TODO)
// ---------------------------------------------------------------------------
const demoAssets: Asset[] = [
  { id: 1, assetType: "HW", name: "web-prd-01", ownerTeam: "인프라운영팀", location: "IDC-A", vendor: "Dell", model: "R650", status: "active", eolDate: "2028-06-30" },
  { id: 2, assetType: "WAS", name: "order-was", ownerTeam: "주문개발팀", location: "IDC-A", vendor: "Red Hat", model: "JBoss EAP 7.4", status: "active", eolDate: null },
  { id: 3, assetType: "SAP", name: "sap-erp-prd", ownerTeam: "ERP팀", location: "IDC-B", vendor: "SAP", model: "S/4HANA 2023", status: "active", eolDate: null },
];
let nextId = 4;

const auditLog: Array<{
  assetId: number | null;
  actor: string;
  action: string;
  detail: string;
  reason: string | null;
  at: string;
}> = [];

function matches(a: Asset, f: AssetFilter): boolean {
  if (f.assetType && a.assetType !== f.assetType) return false;
  if (f.status && a.status !== f.status) return false;
  if (f.keyword) {
    const kw = f.keyword.toLowerCase();
    const hit = [a.name, a.model, a.vendor].some((v) => v?.toLowerCase().includes(kw));
    if (!hit) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// DAO 함수 — server.ts가 사용하는 공식 인터페이스.
// 실 구현 시 각 함수 본문을 SQL/ORM 호출로 교체. 전부 async인 이유는
// 실제 DB가 비동기이기 때문 (데모 구현만 동기적으로 동작).
// ---------------------------------------------------------------------------

/** 목록 조회 + 페이지네이션. total을 함께 반환해야 에이전트가 has_more를 판단한다. */
export async function listAssets(
  filter: AssetFilter,
  page: number,
  pageSize: number,
): Promise<{ total: number; items: Asset[] }> {
  // TODO: SELECT ... WHERE ... LIMIT ? OFFSET ? + SELECT COUNT(*)
  const all = demoAssets.filter((a) => matches(a, filter));
  return {
    total: all.length,
    items: all.slice((page - 1) * pageSize, page * pageSize),
  };
}

export async function getAssetById(id: number): Promise<Asset | null> {
  // TODO: SELECT ... WHERE id = ?
  return demoAssets.find((a) => a.id === id) ?? null;
}

/** group_by 집계. groupBy 값은 server.ts에서 화이트리스트 검증 후 넘어온다. */
export async function summarizeAssets(
  groupBy: keyof Asset,
  filter: AssetFilter,
): Promise<Array<{ key: string; count: number }>> {
  // TODO: SELECT <col>, COUNT(*) ... GROUP BY <col> ORDER BY COUNT(*) DESC
  //       (컬럼명은 반드시 화이트리스트 → 식별자 바인딩. 문자열 조립 금지)
  const counts = new Map<string, number>();
  for (const a of demoAssets.filter((x) => matches(x, filter))) {
    const key = (a[groupBy] as string | null) ?? "(미지정)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((x, y) => y.count - x.count);
}

/** 부분 업데이트. 반환값은 갱신된 자산 (없으면 null). */
export async function updateAsset(
  id: number,
  fields: Partial<Asset>,
): Promise<Asset | null> {
  // TODO: UPDATE assets SET ... WHERE id = ?  (fields 키는 이미 화이트리스트 검증됨)
  const a = demoAssets.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, fields);
  return a;
}

export async function insertAsset(fields: Omit<Asset, "id">): Promise<Asset> {
  // TODO: INSERT INTO assets ...
  const a: Asset = { ...fields, id: nextId++ };
  demoAssets.push(a);
  return a;
}

/**
 * 감사 로그. MCP를 통한 변경은 "에이전트가 한 일"이라 반드시 추적 요구가 나온다.
 * 기존 앱에 감사 테이블이 있으면 거기에 쓰도록 교체. (TODO)
 */
export async function writeAudit(entry: {
  assetId: number | null;
  actor: string;
  action: string; // update | excel_import | ...
  detail: unknown; // 변경 전/후 등
  reason: string | null;
}): Promise<void> {
  auditLog.push({
    ...entry,
    detail: JSON.stringify(entry.detail).slice(0, 2000),
    at: new Date().toISOString(),
  });
}
