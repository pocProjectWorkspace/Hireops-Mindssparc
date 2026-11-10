/**
 * PC-2 — minimal, defensive in-memory ZIP reader for bulk CV upload.
 *
 * Why hand-rolled rather than a dependency: the platform has no direct zip
 * dependency (jszip arrives only transitively via mammoth), and the general
 * libraries inflate first and ask questions later. Here every guard is
 * applied BEFORE bytes are inflated, and inflation itself is capped:
 *
 *   - archive bytes        ≤ maxArchiveBytes (the batch cap)
 *   - entry count          ≤ maxEntries (central directory, before reading
 *                            any entry — a 1M-entry archive is refused whole)
 *   - per entry            declared size ≤ maxEntryBytes, else skipped
 *                          `too_large`; inflate runs with maxOutputLength =
 *                          declared size, so a lying header cannot expand
 *                          past it (zlib throws), and the output length + CRC
 *                          must match the header
 *   - compression ratio    > MAX_COMPRESSION_RATIO on a non-trivial entry is
 *                          a bomb signature → skipped `suspicious_compression`
 *   - total inflated       ≤ maxTotalBytes; the first entry that would exceed
 *                          it is skipped `batch_size_exceeded` (and so is
 *                          everything after it)
 *   - unsafe names         absolute paths, drive letters, `..` segments,
 *                          backslash traversal, NUL / control chars → skipped
 *                          `unsafe_path` (nothing is ever written to disk, but
 *                          such a name is never a legitimate CV and is never
 *                          stored or displayed raw)
 *   - nested archives      skipped `nested_archive` (no recursion → no
 *                          zip-in-zip quine)
 *   - encrypted / zip64 /
 *     unknown methods      skipped (or the archive refused for zip64)
 *
 * Supports STORED (0) and DEFLATE (8) — what every OS "compress folder" and
 * every mail client produces. Folders are flattened: an entry's display name
 * is its path inside the archive.
 */

import { crc32, inflateRawSync } from "node:zlib";

export interface ZipLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export interface ZipFileEntry {
  /** Path inside the archive, normalised to forward slashes. */
  path: string;
  data: Buffer;
}

export interface ZipSkippedEntry {
  path: string;
  reason: ZipSkipReason;
}

export type ZipSkipReason =
  | "unsafe_path"
  | "too_large"
  | "suspicious_compression"
  | "batch_size_exceeded"
  | "nested_archive"
  | "encrypted"
  | "unsupported_compression"
  | "corrupt_entry";

export interface ZipReadResult {
  files: ZipFileEntry[];
  skipped: ZipSkippedEntry[];
}

/** Whole-archive refusal (as opposed to a per-entry skip). */
export class ZipArchiveError extends Error {
  constructor(
    public readonly code:
      | "archive_too_large"
      | "not_a_zip"
      | "too_many_entries"
      | "zip64_not_supported"
      | "corrupt_archive",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ZipArchiveError";
  }
}

/** Inflated:compressed above this, on an entry over 1 MB inflated, is a bomb signature. */
export const MAX_COMPRESSION_RATIO = 100;
const RATIO_CHECK_MIN_BYTES = 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** OS / editor litter that is silently ignored (not reported as skipped). */
export function isJunkPath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  return (
    segments.includes("__MACOSX") ||
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    base === "desktop.ini" ||
    base.startsWith("._") ||
    base.startsWith("~$")
  );
}

/**
 * A safe archive path: relative, no `..`, no drive letter, no control chars.
 * Exported for the unit tests and reused for top-level upload names.
 */
export function isSafeArchivePath(raw: string): boolean {
  if (raw.length === 0 || raw.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
  if (raw.startsWith("/") || raw.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(raw)) return false;
  const segments = raw.split(/[\\/]/);
  return !segments.some((s) => s === ".." || s === ".");
}

const NESTED_ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|jar)$/i;

export function readZip(buffer: Buffer, limits: ZipLimits): ZipReadResult {
  if (buffer.length > limits.maxArchiveBytes) {
    throw new ZipArchiveError("archive_too_large");
  }
  if (buffer.length < EOCD_MIN || buffer.readUInt32LE(0) !== SIG_LOC) {
    // An empty archive starts with the EOCD itself; anything else is not a zip.
    if (!(buffer.length >= EOCD_MIN && buffer.readUInt32LE(0) === SIG_EOCD)) {
      throw new ZipArchiveError("not_a_zip");
    }
  }

  // ── End of central directory (scan backwards past an optional comment) ──
  let eocd = -1;
  const scanFloor = Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN; i >= scanFloor; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipArchiveError("not_a_zip");

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipArchiveError("zip64_not_supported");
  }
  if (totalEntries > limits.maxEntries) {
    throw new ZipArchiveError("too_many_entries");
  }
  if (cdOffset + cdSize > eocd) throw new ZipArchiveError("corrupt_archive");

  const files: ZipFileEntry[] = [];
  const skipped: ZipSkippedEntry[] = [];
  let totalInflated = 0;
  let budgetExhausted = false;

  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CEN) {
      throw new ZipArchiveError("corrupt_archive");
    }
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buffer.length) throw new ZipArchiveError("corrupt_archive");
    // Bit 11 = UTF-8 name; otherwise CP437, which latin1 approximates well
    // enough for a display name.
    const rawName = buffer.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipArchiveError("zip64_not_supported");
    }

    // Directories carry no content.
    if (rawName.endsWith("/") || rawName.endsWith("\\")) continue;

    if (!isSafeArchivePath(rawName)) {
      skipped.push({ path: sanitiseDisplayPath(rawName), reason: "unsafe_path" });
      continue;
    }
    const path = rawName.replace(/\\/g, "/");
    if (isJunkPath(path)) continue;

    if (NESTED_ARCHIVE_EXT.test(path)) {
      skipped.push({ path, reason: "nested_archive" });
      continue;
    }
    if (flags & 0x1) {
      skipped.push({ path, reason: "encrypted" });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ path, reason: "unsupported_compression" });
      continue;
    }
    if (size > limits.maxEntryBytes) {
      skipped.push({ path, reason: "too_large" });
      continue;
    }
    if (size >= RATIO_CHECK_MIN_BYTES && size > compSize * MAX_COMPRESSION_RATIO) {
      skipped.push({ path, reason: "suspicious_compression" });
      continue;
    }
    if (budgetExhausted || totalInflated + size > limits.maxTotalBytes) {
      budgetExhausted = true;
      skipped.push({ path, reason: "batch_size_exceeded" });
      continue;
    }

    // ── Local header → data ──
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOC) {
      skipped.push({ path, reason: "corrupt_entry" });
      continue;
    }
    const locNameLen = buffer.readUInt16LE(localOffset + 26);
    const locExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + locNameLen + locExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buffer.length) {
      skipped.push({ path, reason: "corrupt_entry" });
      continue;
    }
    const compressed = buffer.subarray(dataStart, dataEnd);

    let data: Buffer;
    try {
      if (method === 0) {
        if (compSize !== size) throw new Error("stored size mismatch");
        data = Buffer.from(compressed);
      } else {
        // maxOutputLength caps inflation at the DECLARED size: a header that
        // under-reports cannot make us allocate more (zlib throws RangeError).
        // A zero-byte declared size gets 1 so a lying empty entry also throws.
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) });
      }
      if (data.length !== size || crc32(data) !== crc) throw new Error("size/crc mismatch");
    } catch {
      skipped.push({ path, reason: "corrupt_entry" });
      continue;
    }

    totalInflated += data.length;
    files.push({ path, data });
  }

  return { files, skipped };
}

/** A printable, bounded rendering of an untrusted name for the status list. */
export function sanitiseDisplayPath(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 255);
}
