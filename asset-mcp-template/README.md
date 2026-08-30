# asset-mcp-template

기존 **Node.js API 서버에 MCP 서버 2개를 얹는** 템플릿 (TypeScript + 공식 MCP SDK).

```
                              ┌─▶ [db-mcp  /mcp/db]  ──▶ 자산 DB (HW/SW/WAS/DB/SAP)
사내 AI 에이전트 ─(streamable-http)┤        │
                              └─▶ [ai-mcp  /mcp/ai]  ──▶ 다른 사내 AI (DRM 해제, 분석)
                                        │
                                 공유 파일 저장소 (file_id로 파일 전달)
```

대표 시나리오 — DRM 걸린 자산 엑셀 취합:

1. 사용자가 DRM 엑셀 업로드 → 에이전트가 `ai-mcp.unlock_drm_excel(file_base64)` 호출
2. 해제본이 서버에 저장되고 **file_id** 반환 (파일 내용은 컨텍스트에 싣지 않음)
3. `ai-mcp.analyze_file(file_id, "…분석")` → 사내 AI 분석 요약/결과 파일
4. 필요 시 `db-mcp.import_assets_excel(file_id)` → **dry-run 미리보기 → 사용자 확인 → apply=true** 로 DB 반영

## 파일 구조

```
src/
├── db-mcp.ts        # ★ 자산 DB MCP — 툴 6개 (조회/집계/엑셀 export/import/수정)
├── ai-mcp.ts        # ★ 사내 AI 위임 MCP — unlock_drm_excel, analyze_file
├── internal-ai.ts   # 다른 사내 AI HTTP 클라이언트 (실제 API 스펙으로 교체할 TODO 스텁)
├── files.ts         # 공유 파일 저장소 — file_id 발급/조회 (두 MCP의 파일 통로)
├── excel.ts         # 엑셀 생성/파싱 (exceljs)
├── db.ts            # DB 접근 레이어 — in-memory 데모, 실 DB로 교체
├── mcp-router.ts    # ★ 기존 Express 앱에 붙이는 레이어 (인증, stateless 배선, 다운로드)
└── standalone.ts    # 로컬 개발용 단독 실행 엔트리
```

## 툴 목록

| MCP | 툴 | 종류 | 설명 |
| --- | --- | --- | --- |
| db | `list_assets` | 읽기 | 필터(타입/키워드/상태) + 페이지네이션 목록 조회 |
| db | `get_asset` | 읽기 | 자산 1건 상세 |
| db | `asset_summary` | 읽기 | 타입별/부서별/상태별 집계 |
| db | `export_assets_excel` | 읽기 | 조회 결과 → xlsx 생성 → file_id + 다운로드 URL |
| db | `import_assets_excel` | 쓰기 | 엑셀(file_id 또는 base64) → dry-run 미리보기 → `apply=true` 반영 |
| db | `update_asset` | 쓰기 | 자산 1건 수정 + 감사 로그 |
| ai | `unlock_drm_excel` | 위임 | DRM 파일을 사내 AI로 해제 → 해제본 file_id 반환 |
| ai | `analyze_file` | 위임 | 파일(file_id/base64)을 사내 AI로 분석 → 요약 + 결과 파일 file_id |

## 바로 실행해 보기 (데모 데이터 내장)

```bash
npm install
npm run dev        # db-mcp → :8000/mcp/db, ai-mcp → :8000/mcp/ai
```

다른 터미널에서 Inspector로 확인:

```bash
npx @modelcontextprotocol/inspector
```

→ Transport: **Streamable HTTP**, URL: `http://localhost:8000/mcp/db` (또는 `/mcp/ai`) 연결.
`INTERNAL_AI_URL` 미설정 상태에서는 ai-mcp 툴이 안내 에러를 반환한다 (정상 동작).

## 배포 형태 — 단독 서비스 vs 기존 서버에 얹기

**단독 서비스 (Dockerfile 포함):** `standalone.ts`가 그대로 프로덕션 엔트리다.

```bash
docker build -t asset-mcp .
docker run -p 8000:8000 -v mcp-exports:/data/exports \
  -e MCP_API_KEYS=... -e ASSET_MCP_DOWNLOAD_BASE_URL=https://<외부주소> asset-mcp
```

단독 모드에서는 다운로드 라우트(`/mcp-downloads`)도 이 서비스가 서빙하므로
`ASSET_MCP_DOWNLOAD_BASE_URL`을 **이 서비스의 외부 노출 주소**로 설정한다.

**기존 서버에 얹기:** 아래 통합 절차 참고 (코드는 두 모드 동일 — `attachAllMcp(app)`).

## 기존 API 서버에 통합하기

1. dependencies 4개(`@modelcontextprotocol/sdk`, `zod`, `exceljs`, `jsonwebtoken`)를 기존 앱에 추가.
2. `src/` 파일들을 기존 앱 소스 트리로 복사 (예: `src/mcp/`).
3. `db.ts`의 in-memory 데모 구현을 **기존 앱의 DB 클라이언트**(mysql2/pg/knex/prisma 등)로 교체 — 함수 시그니처는 유지하고 본문만.
4. `internal-ai.ts`를 **실제 사내 AI API 스펙**(URL/인증/multipart 여부/동기 여부)에 맞게 교체.
5. 기존 앱 부트스트랩에 두 줄 추가:
   ```ts
   import { attachAllMcp } from "./mcp/mcp-router.js";
   attachAllMcp(app);
   ```
6. 사내 AI 에이전트에 MCP **두 개** 등록: `https://<기존서버>/mcp/db`, `https://<기존서버>/mcp/ai`

- Express가 아닌 프레임워크(Fastify/Koa/Nest)나 별도 포트 분리는 `mcp-router.ts` 상단 주석 참고.
- 스키마 수정 포인트는 코드 내 `TODO` 주석: 자산 타입 코드값(`db.ts` `ASSET_TYPES`), 수정 허용 컬럼(`WRITABLE_FIELDS`), 엑셀 헤더 매핑(`db-mcp.ts` `headerMap`), 사내 AI API(`internal-ai.ts` 전체).

## file_id 방식 — 두 MCP가 파일을 주고받는 법

파일을 base64로 에이전트 컨텍스트에 태워 왕복시키면 파일이 조금만 커져도 토큰이 터진다.
그래서 **파일은 서버 디스크(`files.ts`)에 두고, 툴 사이에서는 `file_id` 문자열만 주고받는다.**

- base64 입력은 "사용자가 방금 올린 파일을 처음 건네받을 때"만 사용.
- 서버가 만든 파일(export 엑셀, DRM 해제본, 분석 결과)은 항상 file_id + 다운로드 URL로 반환.
- 이 방식은 두 MCP가 **같은 프로세스(또는 같은 볼륨)** 에 있어야 성립.
  완전히 별도 서비스로 분리하면 `files.ts`를 공유 스토리지(NFS/오브젝트 스토리지)로 교체.

## 인증 / 환경변수

`mcp-router.ts`의 `mcpAuth`가 두 MCP 공통으로 처리한다. 헤더 두 종류를 지원:

- **고정 키 허용목록** (`MCP_API_KEYS` 설정 시) — `X-Api-Key` 값이 발급해둔 고정 키일 때. 콤마로 여러 키 등록.
- **토큰(JWT) 서명 검증** (`MCP_TOKEN_VERIFY_SECRET` 설정 시) — `sub`가 감사 로그 actor.
  토큰이 실리는 헤더는 `MCP_TOKEN_HEADER`로 선택: 기본 `authorization`(Bearer),
  사내 규격이 X-Api-Key에 토큰을 싣는 방식이면 `MCP_TOKEN_HEADER=x-api-key`.
- 사내 토큰이 서명 검증 불가능한 불투명(opaque) 토큰 + 만료 있음이라면 발급처의
  검증 API 호출로 교체해야 한다 — `mcpAuth` 주석의 TODO 참고.

둘 다 켜면 둘 다 통과해야 한다. 모두 미설정이면 무인증(개발 모드) —
**쓰기/DRM 해제 툴이 있는 운영에서는 최소 하나는 반드시 켤 것.**
헤더는 에이전트에 MCP를 등록할 때 설정되어 모든 호출에 고정으로 실린다 (LLM은 헤더를 만들 수 없음).

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `MCP_API_KEYS` | (없음 = 키 검증 OFF) | `X-Api-Key` 허용 키 목록 (콤마 구분) |
| `MCP_TOKEN_VERIFY_SECRET` | (없음 = JWT 검증 OFF) | JWT HS256 검증 시크릿 |
| `MCP_TOKEN_HEADER` | `authorization` | JWT가 실리는 헤더 (`x-api-key`로 변경 가능) |
| `MCP_TOKEN_ISSUER` / `MCP_TOKEN_AUDIENCE` | – / `asset-mcp` | JWT 클레임 검증 |
| `ASSET_MCP_EXPORT_DIR` | `/tmp/asset-mcp-exports` | 공유 파일 저장 경로 |
| `ASSET_MCP_DOWNLOAD_BASE_URL` | `http://localhost:8000` | 다운로드 URL 베이스(외부 노출 주소) |
| `ASSET_MCP_FILE_TTL_HOURS` | `24` | 생성 파일(export 엑셀 등) 보관 시간 — 지나면 자동 삭제 |
| `ASSET_MCP_UNLOCKED_TTL_HOURS` | `4` | DRM 해제본 보관 시간 (민감 파일이라 짧게) |
| `INTERNAL_AI_URL` | (없음 = ai-mcp 안내 에러) | 다른 사내 AI API 베이스 URL |
| `INTERNAL_AI_TOKEN` | (없음) | 사내 AI 호출용 토큰 |
| `INTERNAL_AI_TIMEOUT_MS` | `120000` | 사내 AI 호출 타임아웃 |

## 설계 원칙 (툴 추가 시에도 유지)

- **읽기/쓰기 분리**: 조회 툴은 `readOnlyHint`, 쓰기 툴은 `destructiveHint`, 외부 서비스 호출 툴은 `openWorldHint`.
- **쓰기는 2단계**: 대량 변경(엑셀 반영)은 dry-run → 사용자 확인 → `apply=true`. 검증 오류 1건이라도 있으면 전체 미반영.
- **사내 AI의 응답은 신뢰하지 않는 데이터**: 분석 결과를 그대로 DB 쓰기로 잇지 않는다 — DB 반영은 반드시 db-mcp의 dry-run 경로로만.
- **응답은 요약된 객체 + 페이지네이션**: DB row/파일 내용 통째 반환 금지.
- **임의 SQL 툴 금지**: 조회는 명시적 툴로만.
- **에러는 행동 지침으로**: throw 대신 `{ error: "…다음에 뭘 하면 되는지…" }`.
- **감사 로그**: DB 쓰기와 DRM 해제는 누가/무엇을/왜 했는지 기록.
- **파일은 TTL로 자동 정리**: stateless라 "세션 종료 시 삭제" 개념이 없다. 스위퍼가 1시간마다 만료 파일을 삭제한다(`files.ts`의 `startFileCleanup`). 만료된 file_id 사용 시 툴이 안내 에러를 반환한다.
- **stateless HTTP**: 요청마다 서버 인스턴스 생성 — 스케일아웃/재배포에 안전.
- **오래 걸리는 AI 작업은 job 패턴으로**: 툴 호출이 1~2분을 넘길 수 있으면 `start_xxx_job`(job_id 즉시 반환) + `get_job_status`(폴링) 두 툴로 쪼갤 것.

## 다음 단계 체크리스트

- [ ] `db.ts`를 실제 자산 DB 스키마/클라이언트로 교체
- [ ] `internal-ai.ts`를 실제 사내 AI API 스펙으로 교체 (DRM 해제/분석 엔드포인트)
- [ ] DRM 해제 감사 로그를 사내 감사 체계에 연동 (`ai-mcp.ts`의 console.log 부분)
- [ ] 파일 TTL 기본값(24h, 해제본 4h)이 사내 보관 정책과 맞는지 확인, 필요 시 디스크 암호화
- [ ] `import_assets_excel`의 반영 블록을 DB 트랜잭션으로 감싸기
- [ ] 사내 인증 방식에 맞게 `mcpAuth` 조정 + 운영에서 인증 ON
- [ ] `/mcp-downloads`에 사내 인증 부착 (자산 데이터 + DRM 해제본은 민감 정보)
- [ ] 사내 에이전트에 두 MCP 등록 후 실제 시나리오(해제→분석→취합→반영)로 검증
