/**
 * 엑셀 export / import 헬퍼 (exceljs).
 *
 * 파일 전달 방식 설계 메모:
 *
 *  - export(서버→사용자): xlsx를 EXPORT_DIR에 쓰고, 기존 API 서버에 붙인
 *    다운로드 엔드포인트의 URL을 툴 응답으로 돌려준다. MCP 응답에 base64를
 *    실을 수도 있지만 파일이 커지면 에이전트 컨텍스트를 낭비하므로 URL이 기본.
 *    (다운로드 라우트는 mcp-router.ts에 있음)
 *
 *  - import(사용자→서버): 에이전트가 파일을 base64로 툴 인자에 담아 보낸다.
 *    사내 에이전트가 업로드 파일을 자체 스토리지 URL로 주는 구조라면
 *    fileUrl 인자를 받아 서버가 직접 fetch하도록 확장하면 된다.
 */

import ExcelJS from "exceljs";

import { saveFileBuffer } from "./files.js";

/**
 * rows를 xlsx로 만들어 공유 파일 저장소에 저장하고 { fileId, downloadUrl } 반환.
 * fileId는 다른 툴(ai-mcp의 analyze_file 등)에 그대로 넘길 수 있다.
 */
export async function writeRowsToXlsx(
  headers: string[],
  rows: Array<Array<string | number | null>>,
  sheetTitle = "assets",
): Promise<{ fileId: string; downloadUrl: string }> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetTitle);
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true }; // 서식 욕심은 여기까지.
  // 복잡한 사내 표준 양식이 필요하면: 미리 만든 template.xlsx를
  // wb.xlsx.readFile()로 열어 값만 채우는 방식을 추천.
  for (const row of rows) ws.addRow(row);

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return saveFileBuffer(buf, "assets", "xlsx");
}

/**
 * base64 xlsx → [{헤더: 값, ...}, ...] 파싱. 1행을 헤더로 간주, 빈 행은 스킵.
 * 실패 시 "에이전트가 읽고 조치할 수 있는" 메시지의 Error를 던진다.
 */
export async function readXlsxBase64(
  fileBase64: string,
): Promise<Array<Record<string, string | number | null>>> {
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    // exceljs 타입 선언이 구식 Buffer 타입을 요구해서 캐스팅 필요 (동작엔 문제 없음)
    await wb.xlsx.load(Buffer.from(fileBase64, "base64") as unknown as ExcelJS.Buffer);
  } catch (e) {
    throw new Error(
      `엑셀 파일을 열 수 없습니다: ${String(e)}. base64 인코딩된 .xlsx인지 확인하세요.`,
    );
  }

  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) throw new Error("엑셀에 데이터가 없습니다 (헤더 행조차 없음).");

  // exceljs의 row.values는 1-based 배열(0번은 undefined)임에 주의
  const headerRow = ws.getRow(1).values as Array<string | undefined>;
  const headers = headerRow.map((h) => (h == null ? "" : String(h).trim()));

  const records: Array<Record<string, string | number | null>> = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // 헤더
    const values = row.values as Array<string | number | null | undefined>;
    if (values.every((v) => v == null)) return; // 빈 행
    const rec: Record<string, string | number | null> = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const v = values[i];
      rec[h] = v == null ? null : (v as string | number);
    });
    records.push(rec);
  });
  return records;
}
