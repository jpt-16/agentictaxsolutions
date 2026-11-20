import { describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { zipSync, strToU8 } from "fflate";
import { randomUUID } from "node:crypto";
import { validateUpload, sanitizeFileName, MAX_FILE_BYTES } from "./validate";
import { ClamdScanner, EicarScanner, ScanUnavailableError, buildScanner } from "./scanner";
import { LocalStorage, MemoryStorage, storageKey } from "./storage";
import { previewSpreadsheet, PREVIEW_MAX_ROWS } from "./preview";
import { makeSeedWorkbook } from "../seed-files";

export async function makeXlsx(rows: (string | number | Date | { formula: string; result: number })[][], sheetName = "TB"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const reject = (name: string, bytes: Buffer, re: RegExp) => expect(() => validateUpload(name, bytes)).toThrow(re);

describe("validateUpload", () => {
  it("accepts well-formed files and derives type/hash itself", async () => {
    const x = validateUpload("TB.XLSX", await makeXlsx([["a", 1]]));
    expect(x).toMatchObject({ kind: "xlsx", safeName: "TB.XLSX" });
    expect(x.contentType).toContain("spreadsheetml");
    expect(x.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateUpload("a.csv", Buffer.from("a,b\n1,2\n")).kind).toBe("csv");
    expect(validateUpload("n.pdf", Buffer.from("%PDF-1.7\n1 0 obj\n")).kind).toBe("pdf");
    expect(validateUpload("p.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])).kind).toBe("png");
  });

  it("rejects unsupported and risky extensions with a helpful message", async () => {
    const b = await makeXlsx([["a"]]);
    reject("book.xlsm", b, /Macro-enabled/);
    reject("old.xls", b, /Save as \.xlsx/);
    reject("run.exe", Buffer.from("MZ"), /not accepted/);
    reject("noext", Buffer.from("hi"), /not accepted/);
  });

  it("rejects content that does not match its extension", async () => {
    reject("fake.xlsx", Buffer.from("just text"), /not a valid XLSX/);
    reject("fake.png", Buffer.from("GIF89a"), /not a valid PNG/);
    reject("fake.jpg", Buffer.from([0x89, 0x50]), /not a valid JPEG/);
    reject("fake.pdf", Buffer.from("hello"), /not a valid PDF/);
    reject("renamed.docx", await makeXlsx([["a"]]), /not a valid DOCX/);
  });

  it("rejects macro-enabled workbooks even when renamed to .xlsx", () => {
    const zip = Buffer.from(zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "xl/vbaProject.bin": strToU8("evil"), "[Content_Types].xml": strToU8("<x/>") }));
    reject("sneaky.xlsx", zip, /macros or embedded executables/);
  });

  it("rejects decompression bombs without inflating them", () => {
    const bomb = Buffer.from(zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "xl/big.bin": new Uint8Array(8 * 1024 * 1024) }, { level: 9 }));
    expect(bomb.length).toBeLessThan(100_000);
    reject("bomb.xlsx", bomb, /decompression bomb/);
  });

  it("rejects password-protected / legacy OLE containers and corrupt zips", () => {
    reject("locked.xlsx", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), /password-protected/);
    reject("corrupt.xlsx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("garbage")]), /corrupt|not a valid/);
  });

  it("rejects active PDFs, binary 'text', empty and oversized files", () => {
    reject("js.pdf", Buffer.from("%PDF-1.4\n<< /JavaScript (app.alert(1)) >>"), /scripts, launch actions/);
    reject("bin.csv", Buffer.from([0x61, 0x00, 0x62]), /not a text file/);
    reject("latin1.txt", Buffer.from([0xff, 0xfe, 0xfa]), /UTF-8/);
    reject("empty.csv", Buffer.alloc(0), /empty/);
    reject("huge.csv", Buffer.alloc(MAX_FILE_BYTES + 1, 0x61), /larger than 25 MB/);
  });

  it("sanitizes display names (paths, control chars, bidi overrides, leading dots)", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\evil\\tb.xlsx")).toBe("tb.xlsx");
    expect(sanitizeFileName("inv\u202Eslx.exe")).toBe("invslx.exe");
    expect(sanitizeFileName("a\u0000b\nc.csv")).toBe("abc.csv");
    expect(sanitizeFileName("...hidden.csv")).toBe("hidden.csv");
    expect(sanitizeFileName("x".repeat(500) + ".csv").length).toBe(200);
  });
});

describe("scanners", () => {
  it("EICAR scanner catches the standard test string and passes clean content", async () => {
    const s = new EicarScanner();
    expect(await s.scan(Buffer.from(`prefix ${EICAR} suffix`))).toMatchObject({ clean: false });
    expect(await s.scan(Buffer.from("totally fine"))).toEqual({ clean: true });
  });

  async function fakeClamd(reply: string | null) {
    let received = Buffer.alloc(0);
    const server = net.createServer((sock) => {
      sock.on("data", (d: Buffer) => {
        received = Buffer.concat([received, d]);
        if (received.subarray(-4).equals(Buffer.alloc(4))) { if (reply === null) sock.destroy(); else sock.end(reply + "\0"); }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { port: (server.address() as net.AddressInfo).port, close: () => server.close(), get received() { return received; } };
  }

  it("speaks INSTREAM and maps OK / FOUND", async () => {
    const ok = await fakeClamd("stream: OK");
    expect(await new ClamdScanner("127.0.0.1", ok.port).scan(Buffer.from("hello"))).toEqual({ clean: true });
    expect(ok.received.subarray(0, 10).toString()).toBe("zINSTREAM\0");
    ok.close();
    const bad = await fakeClamd("stream: Win.Test.EICAR_HDB-1 FOUND");
    expect(await new ClamdScanner("127.0.0.1", bad.port).scan(Buffer.from("x"))).toEqual({ clean: false, signature: "Win.Test.EICAR_HDB-1" });
    bad.close();
  });

  it("fails closed when the scanner errors, drops the connection, or is unreachable", async () => {
    const err = await fakeClamd("stream: size limit exceeded. ERROR");
    await expect(new ClamdScanner("127.0.0.1", err.port).scan(Buffer.from("x"))).rejects.toBeInstanceOf(ScanUnavailableError);
    err.close();
    const drop = await fakeClamd(null);
    await expect(new ClamdScanner("127.0.0.1", drop.port).scan(Buffer.from("x"))).rejects.toBeInstanceOf(ScanUnavailableError);
    drop.close();
    await expect(new ClamdScanner("127.0.0.1", 1, 500).scan(Buffer.from("x"))).rejects.toBeInstanceOf(ScanUnavailableError);
  });

  it("refuses to run without a real scanner in production", () => {
    expect(() => buildScanner({ NODE_ENV: "production" })).toThrow(/CLAMAV_HOST/);
    expect(buildScanner({ NODE_ENV: "development" }).name).toBe("eicar-dev");
    expect(buildScanner({ CLAMAV_HOST: "clam", NODE_ENV: "production" }).name).toBe("clamav");
  });
});

describe("storage", () => {
  const t = randomUUID(), f = randomUUID();
  it("round-trips on disk, never overwrites, and creates private files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "taxops-store-"));
    const s = new LocalStorage(root);
    await s.put(storageKey(t, f), Buffer.from("data"));
    expect((await s.get(storageKey(t, f))).toString()).toBe("data");
    await expect(s.put(storageKey(t, f), Buffer.from("other"))).rejects.toThrow();
    expect((await readFile(path.join(root, t, f))).toString()).toBe("data");
    await s.delete(storageKey(t, f));
    await expect(s.get(storageKey(t, f))).rejects.toThrow();
  });
  it("rejects any key that is not <tenant uuid>/<file uuid> (path traversal)", async () => {
    const s = new LocalStorage(await mkdtemp(path.join(os.tmpdir(), "taxops-store-")));
    for (const bad of ["../../etc/passwd", `${t}/../${f}`, `${t}/${f}/x`, "a/b", `/${t}/${f}`, ""]) {
      await expect(s.get(bad)).rejects.toThrow(/Invalid storage key/);
      await expect(new MemoryStorage().put(bad, Buffer.from("x"))).rejects.toThrow();
    }
  });
});

describe("previewSpreadsheet", () => {
  it("reads sheets, dates and cached formula results as plain text", async () => {
    const buf = await makeXlsx([["Account", "Debit", "Credit"], ["1000 Cash", 100, 0], [new Date("2025-12-31T00:00:00Z"), { formula: "SUM(B2:B2)", result: 100 }, ""]]);
    const p = await previewSpreadsheet(buf, "xlsx");
    expect(p.sheets.map((s) => s.name)).toEqual(["TB"]);
    expect(p.rows[0]).toEqual(["Account", "Debit", "Credit"]);
    expect(p.rows[2]![0]).toBe("2025-12-31");
    expect(p.rows[2]![1]).toBe("100");
  });
  it("caps rows and columns and reports truncation", async () => {
    const rows = Array.from({ length: PREVIEW_MAX_ROWS + 50 }, (_, i) => Array.from({ length: 40 }, (_, c) => `r${i}c${c}`));
    const p = await previewSpreadsheet(await makeXlsx(rows), "xlsx");
    expect(p.rows).toHaveLength(PREVIEW_MAX_ROWS);
    expect(p.rows[0]).toHaveLength(30);
    expect(p).toMatchObject({ truncatedRows: true, truncatedCols: true, totalRows: PREVIEW_MAX_ROWS + 50, totalCols: 40 });
  });
  it("selects a sheet by name and parses CSV (with BOM, ragged rows, quotes)", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("One").addRow(["x"]); wb.addWorksheet("Two").addRow(["y"]);
    const p = await previewSpreadsheet(Buffer.from(await wb.xlsx.writeBuffer()), "xlsx", "Two");
    expect(p).toMatchObject({ active: "Two", rows: [["y"]] });
    const csv = await previewSpreadsheet(Buffer.from('\uFEFFa,b\n"x,1",2,3\n'), "csv");
    expect(csv.rows).toEqual([["a", "b"], ["x,1", "2", "3"]]);
    expect(csv.totalCols).toBe(3);
  });
  it("never evaluates content: a formula-looking string is just text", async () => {
    const p = await previewSpreadsheet(await makeXlsx([["=HYPERLINK(\"http://evil\")", "+cmd|' /C calc'!A0"]]), "xlsx");
    expect(p.rows[0]).toEqual(["=HYPERLINK(\"http://evil\")", "+cmd|' /C calc'!A0"]);
  });
});

describe("demo workbook generator", () => {
  it("produces balanced trial balances, except the one deliberately unbalanced sheet (off by exactly 12,450)", async () => {
    const sheets = ["NWU – GBP", "NWI – EUR", "NWG – EUR", "NWF – EUR", "NWN – EUR"];
    const buf = await makeSeedWorkbook({ kind: "tb", fileName: "x.xlsx", sheets, unbalancedSheet: "NWF – EUR" });
    for (const name of sheets) {
      const p = await previewSpreadsheet(buf, "xlsx", name);
      const total = p.rows.at(-1)!;
      expect(total[1]).toBe("Total");
      const gap = Number(total[2]) - Number(total[3]);
      expect(gap, name).toBe(name === "NWF – EUR" ? 12_450 : 0);
      for (const row of p.rows.slice(1, -1)) expect(Number(row[2]) >= 0 && Number(row[3]) >= 0).toBe(true);
    }
  });
});
