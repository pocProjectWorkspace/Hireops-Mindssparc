/**
 * PC-2 — zip handling + file classification for bulk CV upload. Pure: no DB,
 * no storage. Archives are built in-test by a tiny writer (STORED / DEFLATE,
 * real CRCs) so every case is a byte-exact zip, including hostile ones whose
 * headers lie.
 *
 * Coverage:
 *   1. nested folders flatten to `folder/sub/file.pdf`; PDF + DOCX accepted
 *   2. non-CV files skipped with a reason; OS litter (__MACOSX, .DS_Store)
 *      silently ignored; directories ignored
 *   3. oversize entry (declared size over the per-file cap) skipped too_large
 *   4. path traversal / absolute / drive-letter / control-char names → unsafe_path
 *   5. zip bomb: a header that UNDER-declares the inflated size → corrupt_entry
 *      (inflation is capped at the declared size); a huge ratio → suspicious
 *   6. nested archive / encrypted entry skipped; too many entries refused whole
 *   7. batch byte budget: entries past it skipped batch_size_exceeded
 *   8. expandUpload: loose files + zip together, content sniffing (a .pdf that
 *      is not a PDF), legacy .doc, unsafe top-level names
 */

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { crc32, deflateRawSync } from "node:zlib";
import {
  readZip,
  isSafeArchivePath,
  ZipArchiveError,
  type ZipLimits,
} from "../src/lib/bulk-cv/zip";
import { expandUpload, DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE } from "../src/lib/bulk-cv/expand";

interface Entry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Override the declared uncompressed size (hostile header). */
  declaredSize?: number;
  encrypted?: boolean;
}

/** Minimal ZIP writer (no zip64, no data descriptors). */
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const name = Buffer.from(e.name, "utf8");
    const comp = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const flags = 0x800 | (e.encrypted ? 0x1 : 0);

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(flags, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(size, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    locals.push(loc, name, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);

    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const PDF = (tag: string) => Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj << >> endobj\n%%EOF\n`);
/** Enough of a DOCX for the sniff: a zip whose part names include word/. */
const DOCX = (tag: string) =>
  makeZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(`<w:document>${tag}</w:document>`) },
  ]);

const MB = 1024 * 1024;
const LIMITS: ZipLimits = {
  maxArchiveBytes: 200 * MB,
  maxEntries: 5000,
  maxEntryBytes: 10 * MB,
  maxTotalBytes: 200 * MB,
};

function reasons(r: { skipped: { path: string; reason: string }[] }): Record<string, string> {
  return Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
}

describe("PC-2 bulk CV — zip reader", () => {
  it("1. nested folders are flattened to their archive path; PDF + DOCX read back intact", () => {
    const pdf = PDF("a");
    const docx = DOCX("b");
    const zip = makeZip([
      { name: "cvs/", data: Buffer.alloc(0), method: 0 },
      { name: "cvs/finance/anita.pdf", data: pdf },
      { name: "cvs/finance/2026/ravi.docx", data: docx, method: 0 },
      { name: "top.pdf", data: PDF("c") },
    ]);
    const r = readZip(zip, LIMITS);
    assert.deepEqual(r.files.map((f) => f.path).sort(), [
      "cvs/finance/2026/ravi.docx",
      "cvs/finance/anita.pdf",
      "top.pdf",
    ]);
    assert.ok(r.files.find((f) => f.path === "cvs/finance/anita.pdf")?.data.equals(pdf));
    assert.ok(r.files.find((f) => f.path === "cvs/finance/2026/ravi.docx")?.data.equals(docx));
    assert.equal(r.skipped.length, 0);
  });

  it("2. OS litter and directories are ignored silently", () => {
    const zip = makeZip([
      { name: "__MACOSX/cvs/._anita.pdf", data: Buffer.from("junk") },
      { name: "cvs/.DS_Store", data: Buffer.from("junk") },
      { name: "cvs/~$draft.docx", data: Buffer.from("junk") },
      { name: "cvs/anita.pdf", data: PDF("a") },
    ]);
    const r = readZip(zip, LIMITS);
    assert.deepEqual(
      r.files.map((f) => f.path),
      ["cvs/anita.pdf"],
    );
    assert.equal(r.skipped.length, 0);
  });

  it("3. an entry over the per-file cap is skipped too_large without being inflated", () => {
    const big = Buffer.alloc(2 * MB, 0x41);
    const zip = makeZip([
      { name: "big.pdf", data: big, method: 0 },
      { name: "ok.pdf", data: PDF("ok") },
    ]);
    const r = readZip(zip, { ...LIMITS, maxEntryBytes: 1 * MB });
    assert.equal(reasons(r)["big.pdf"], "too_large");
    assert.deepEqual(
      r.files.map((f) => f.path),
      ["ok.pdf"],
    );
  });

  it("4. path traversal, absolute, drive-letter and control-char names are rejected", () => {
    const zip = makeZip([
      { name: "../../etc/passwd.pdf", data: PDF("x") },
      { name: "cvs/../../evil.pdf", data: PDF("x") },
      { name: "/abs/evil.pdf", data: PDF("x") },
      { name: "C:/Windows/evil.pdf", data: PDF("x") },
      { name: "..\\..\\win.pdf", data: PDF("x") },
      { name: "cvs/bad\u0001name.pdf", data: PDF("x") },
      { name: "cvs/good.pdf", data: PDF("g") },
    ]);
    const r = readZip(zip, LIMITS);
    assert.deepEqual(
      r.files.map((f) => f.path),
      ["cvs/good.pdf"],
    );
    assert.equal(r.skipped.length, 6);
    assert.ok(r.skipped.every((s) => s.reason === "unsafe_path"));
    // Displayed names are sanitised (no raw control characters).
    // eslint-disable-next-line no-control-regex
    assert.ok(r.skipped.every((s) => !/[\u0000-\u001f]/.test(s.path)));

    assert.equal(isSafeArchivePath("a/b/c.pdf"), true);
    assert.equal(isSafeArchivePath("a/./c.pdf"), false);
    assert.equal(isSafeArchivePath(""), false);
  });

  it("5. zip bomb: an under-declared size cannot inflate past the header; a huge ratio is refused", () => {
    // 5 MB of zeros deflates to a few KB. Header claims 1 KB.
    const zeros = Buffer.alloc(5 * MB, 0);
    const lying = makeZip([{ name: "bomb.pdf", data: zeros, declaredSize: 1024 }]);
    const r1 = readZip(lying, LIMITS);
    assert.equal(r1.files.length, 0);
    assert.equal(reasons(r1)["bomb.pdf"], "corrupt_entry");

    // Honest header, but ~1000:1 ratio on a multi-MB entry → bomb signature.
    const honest = makeZip([{ name: "zeros.pdf", data: zeros }]);
    const r2 = readZip(honest, LIMITS);
    assert.equal(r2.files.length, 0);
    assert.equal(reasons(r2)["zeros.pdf"], "suspicious_compression");
  });

  it("6. nested archives + encrypted entries are skipped; too many entries refuses the archive", () => {
    const zip = makeZip([
      { name: "inner.zip", data: makeZip([{ name: "a.pdf", data: PDF("a") }]) },
      { name: "secret.pdf", data: PDF("s"), encrypted: true },
      { name: "plain.pdf", data: PDF("p") },
    ]);
    const r = readZip(zip, LIMITS);
    assert.equal(reasons(r)["inner.zip"], "nested_archive");
    assert.equal(reasons(r)["secret.pdf"], "encrypted");
    assert.deepEqual(
      r.files.map((f) => f.path),
      ["plain.pdf"],
    );

    const many = makeZip(
      Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.pdf`, data: PDF(String(i)) })),
    );
    assert.throws(
      () => readZip(many, { ...LIMITS, maxEntries: 10 }),
      (e: unknown) => e instanceof ZipArchiveError && e.code === "too_many_entries",
    );
    assert.throws(
      () => readZip(many, { ...LIMITS, maxArchiveBytes: 100 }),
      (e: unknown) => e instanceof ZipArchiveError && e.code === "archive_too_large",
    );
    assert.throws(
      () => readZip(Buffer.from("definitely not a zip file at all"), LIMITS),
      (e: unknown) => e instanceof ZipArchiveError && e.code === "not_a_zip",
    );
  });

  it("7. the batch byte budget stops inflation; later entries are batch_size_exceeded", () => {
    const a = Buffer.concat([PDF("a"), Buffer.alloc(600 * 1024, 0x20)]);
    const b = Buffer.concat([PDF("b"), Buffer.alloc(600 * 1024, 0x20)]);
    const zip = makeZip([
      { name: "a.pdf", data: a, method: 0 },
      { name: "b.pdf", data: b, method: 0 },
    ]);
    const r = readZip(zip, { ...LIMITS, maxTotalBytes: 1 * MB });
    assert.deepEqual(
      r.files.map((f) => f.path),
      ["a.pdf"],
    );
    assert.equal(reasons(r)["b.pdf"], "batch_size_exceeded");
  });
});

describe("PC-2 bulk CV — expandUpload", () => {
  const EXPAND = { maxFileBytes: 10 * MB, remainingBytes: 200 * MB, maxZipEntries: 5000 };

  it("8. loose files + a zip, sniffed by content; non-CVs and unsafe names skipped", () => {
    const zip = makeZip([
      { name: "batch/anita.pdf", data: PDF("anita") },
      { name: "batch/notes.txt", data: Buffer.from("hello") },
      { name: "batch/photo.jpg", data: Buffer.from([0xff, 0xd8, 0xff]) },
      { name: "batch/old.doc", data: Buffer.from("legacy") },
    ]);
    const out = expandUpload(
      [
        { name: "ravi.docx", data: DOCX("ravi") },
        { name: "loose.pdf", data: PDF("loose") },
        { name: "fake.pdf", data: Buffer.from("this is not a pdf") },
        { name: "agency-drop.zip", data: zip },
        { name: "..", data: PDF("x") },
      ],
      EXPAND,
    );
    const accepted = Object.fromEntries(out.accepted.map((a) => [a.fileName, a.contentType]));
    assert.deepEqual(accepted, {
      "ravi.docx": DOCX_CONTENT_TYPE,
      "loose.pdf": PDF_CONTENT_TYPE,
      "agency-drop.zip/batch/anita.pdf": PDF_CONTENT_TYPE,
    });
    const skipped = Object.fromEntries(out.skipped.map((s) => [s.fileName, s.reason]));
    assert.equal(skipped["fake.pdf"], "not_a_valid_file");
    assert.equal(skipped["agency-drop.zip/batch/notes.txt"], "not_a_cv_type");
    assert.equal(skipped["agency-drop.zip/batch/photo.jpg"], "not_a_cv_type");
    assert.equal(skipped["agency-drop.zip/batch/old.doc"], "legacy_doc_not_supported");
    assert.equal(skipped[".."], "unsafe_path");
    // Every accepted CV carries a sha256 checksum (same-file dedup key).
    assert.ok(out.accepted.every((a) => /^[0-9a-f]{64}$/.test(a.checksum)));
  });

  it("9. a loose file over the per-file cap is too_large; a corrupt zip is reported, not thrown", () => {
    const out = expandUpload(
      [
        { name: "huge.pdf", data: Buffer.concat([PDF("h"), Buffer.alloc(2 * MB)]) },
        { name: "broken.zip", data: Buffer.from("PK\u0003\u0004 truncated") },
      ],
      { ...EXPAND, maxFileBytes: 1 * MB },
    );
    const skipped = Object.fromEntries(out.skipped.map((s) => [s.fileName, s.reason]));
    assert.equal(skipped["huge.pdf"], "too_large");
    assert.ok(["not_a_zip", "corrupt_archive"].includes(skipped["broken.zip"] ?? ""));
    assert.equal(out.accepted.length, 0);
  });
});
