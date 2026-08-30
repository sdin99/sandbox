/**
 * 공유 파일 저장소 — 두 MCP(db-mcp, ai-mcp)가 파일을 주고받는 통로.
 *
 * 왜 필요한가: 엑셀을 base64로 에이전트 컨텍스트에 태워 왕복시키면 파일이
 * 조금만 커져도 토큰이 터진다. 그래서 파일은 서버 디스크에 두고, 툴 사이에서는
 * `file_id` 문자열만 주고받는다. 흐름 예:
 *
 *   ai-mcp.unlock_drm_excel  → 해제본 저장 → file_id 반환
 *   db-mcp.import_assets_excel(file_id)  → file_id로 파일을 읽어 DB 반영
 *
 * 두 MCP가 같은 프로세스(또는 같은 볼륨을 마운트한 컨테이너)에 있어야
 * 이 방식이 성립한다. MCP를 서로 다른 서버로 완전히 분리한다면 이 레이어를
 * 공유 스토리지(NFS/S3 호환 오브젝트 스토리지)로 교체할 것.
 *
 * 운영 메모: DRM 해제본이 이 디렉토리에 남는다. 보관 정책(자동 삭제 잡,
 * 디스크 암호화)을 반드시 정하고, 다운로드 라우트에는 사내 인증을 붙일 것.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** 파일 저장 디렉토리. 컨테이너라면 emptyDir/PVC 마운트 경로로. */
export const EXPORT_DIR =
  process.env.ASSET_MCP_EXPORT_DIR ?? "/tmp/asset-mcp-exports";

/** 다운로드 URL 베이스 — 기존 API 서버가 외부에 노출된 주소. */
const DOWNLOAD_BASE_URL =
  process.env.ASSET_MCP_DOWNLOAD_BASE_URL ?? "http://localhost:8000";

/** file_id는 곧 저장된 파일명. 경로 조작(../ 등)을 막기 위해 문자셋 제한. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function makeFileId(prefix: string, ext: string): string {
  // 랜덤 토큰으로 URL 추측을 어렵게 한다 (그래도 다운로드 라우트 인증이 정석)
  return `${prefix}_${randomBytes(8).toString("hex")}.${ext}`;
}

export function fileUrl(fileId: string): string {
  return `${DOWNLOAD_BASE_URL}/mcp-downloads/${fileId}`;
}

/** 버퍼를 저장하고 { fileId, downloadUrl } 반환. */
export function saveFileBuffer(
  buf: Buffer,
  prefix: string,
  ext: string,
): { fileId: string; downloadUrl: string } {
  mkdirSync(EXPORT_DIR, { recursive: true });
  const fileId = makeFileId(prefix, ext);
  writeFileSync(path.join(EXPORT_DIR, fileId), buf);
  return { fileId, downloadUrl: fileUrl(fileId) };
}

/** file_id로 파일을 읽는다. 형식이 이상하거나 없으면(만료 삭제 포함) null —
 *  호출부에서 에이전트에게 "file_id 확인" 안내 에러로 변환할 것. */
export function readFileBuffer(fileId: string): Buffer | null {
  if (!SAFE_ID.test(fileId)) return null; // 경로 조작 차단
  const p = path.join(EXPORT_DIR, fileId);
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

// ---------------------------------------------------------------------------
// TTL 기반 자동 정리
// ---------------------------------------------------------------------------
// 왜 필요한가: stateless MCP에는 "세션 종료" 개념이 서버에 없어서 파일이
// 저절로 지워질 계기가 없다. 그렇다고 즉시 삭제할 수도 없다 — 사용자가
// 대화가 끝난 뒤에 다운로드 URL을 클릭할 시간이 필요하다. 그래서 TTL 방식.
//
// 파일명 prefix(= saveFileBuffer의 prefix 인자)별로 보관 시간을 달리 둔다:
//   - unlocked_* (DRM 해제본): 민감하므로 짧게 (기본 4시간)
//   - 그 외 (export 엑셀, 분석 결과): 기본 24시간
//
// mtime 기준이라 여러 인스턴스가 같은 볼륨에서 각자 스위퍼를 돌려도 안전
// (멱등). 프로세스 밖에서 처리하고 싶으면 이 함수 대신 K8s CronJob 등에서
//   find $EXPORT_DIR -name 'unlocked_*' -mmin +240 -delete   식으로 해도 된다.

const DEFAULT_TTL_H = Number(process.env.ASSET_MCP_FILE_TTL_HOURS ?? 24);
const UNLOCKED_TTL_H = Number(process.env.ASSET_MCP_UNLOCKED_TTL_HOURS ?? 4);

function ttlMsFor(fileId: string): number {
  const hours = fileId.startsWith("unlocked_") ? UNLOCKED_TTL_H : DEFAULT_TTL_H;
  return hours * 3600 * 1000;
}

/** 만료된 파일을 1회 삭제하고 삭제 건수를 반환. */
export function sweepExpiredFiles(now = Date.now()): number {
  if (!existsSync(EXPORT_DIR)) return 0;
  let removed = 0;
  for (const name of readdirSync(EXPORT_DIR)) {
    if (!SAFE_ID.test(name)) continue; // 우리가 만든 파일만 취급
    const p = path.join(EXPORT_DIR, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > ttlMsFor(name)) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      // 동시 삭제(다른 인스턴스의 스위퍼 등)와의 경합 — 무시해도 안전
    }
  }
  return removed;
}

/** 정리 스위퍼 시작 — attachAllMcp()에서 호출된다. 1시간마다 1회 실행.
 *  unref()로 타이머가 프로세스 종료를 막지 않게 한다. */
export function startFileCleanup(intervalMs = 3600 * 1000): void {
  const run = () => {
    const removed = sweepExpiredFiles();
    if (removed > 0) console.log(`[asset-mcp] file cleanup: ${removed}개 만료 파일 삭제`);
  };
  run(); // 시작(재시작) 직후 한 번 — 다운타임 동안 쌓인 만료분 정리
  setInterval(run, intervalMs).unref();
}
