/**
 * PC-2 — turn an upload request's files (loose CVs and/or .zip archives) into
 * the list of CVs to store plus the list of things refused, with a reason per
 * refusal. Pure: no storage, no DB. The route applies the batch caps around it.
 *
 * File-type check is by CONTENT, not by the browser's Content-Type (which is
 * whatever the OS guesses, and for zip-extracted entries there is none):
 *   - PDF   `%PDF-` within the first 1 KB (the spec tolerates leading junk)
 *   - DOCX  `.docx` name + ZIP local-header magic + a `word/` part name
 * Legacy `.doc` is refused for the same reason the apply form refuses it: the
 * extractor (mammoth) is DOCX-only, so a .doc would only ever parse_fail.
 */

import { createHash } from "node:crypto";
import {
  isJunkPath,
  isSafeArchivePath,
  readZip,
  sanitiseDisplayPath,
  ZipArchiveError,
  type ZipLimits,
} from "./zip";

export const PDF_CONTENT_TYPE = "application/pdf";
export const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type CvContentType = typeof PDF_CONTENT_TYPE | typeof DOCX_CONTENT_TYPE;

export interface UploadedFile {
  name: string;
  data: Buffer;
}

export interface AcceptedCv {
  /** Display name: the file name, or `archive.zip/path/inside.pdf`. */
  fileName: string;
  data: Buffer;
  contentType: CvContentType;
  checksum: string;
}

export interface SkippedFile {
  fileName: string;
  reason: string;
}

export interface ExpandLimits {
  /** Per-file ceiling (MAX_DOCUMENT_BYTES). */
  maxFileBytes: number;
  /** Batch byte budget still available. */
  remainingBytes: number;
  /** Most archive entries a zip may declare before it is refused whole. */
  maxZipEntries: number;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EMPTY_ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export function detectCvContentType(name: string, data: Buffer): CvContentType | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return data.subarray(0, 1024).includes("%PDF-") ? PDF_CONTENT_TYPE : null;
  }
  if (lower.endsWith(".docx")) {
    return data.subarray(0, 4).equals(ZIP_MAGIC) && data.includes("word/")
      ? DOCX_CONTENT_TYPE
      : null;
  }
  return null;
}

function isZipUpload(name: string, data: Buffer): boolean {
  if (name.toLowerCase().endsWith(".zip")) return true;
  const head = data.subarray(0, 4);
  // A zip-magic file that is not named .docx is treated as an archive.
  return (
    (head.equals(ZIP_MAGIC) || head.equals(EMPTY_ZIP_MAGIC)) &&
    !name.toLowerCase().endsWith(".docx")
  );
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Classify one CV candidate (a loose upload or an archive entry). Returns the
 * accepted CV, or a skip reason.
 */
function classify(
  fileName: string,
  data: Buffer,
  maxFileBytes: number,
): AcceptedCv | { skip: string } {
  if (data.length > maxFileBytes) return { skip: "too_large" };
  if (data.length === 0) return { skip: "empty_file" };
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".doc")) return { skip: "legacy_doc_not_supported" };
  const contentType = detectCvContentType(fileName, data);
  if (!contentType) {
    return {
      skip:
        lower.endsWith(".pdf") || lower.endsWith(".docx") ? "not_a_valid_file" : "not_a_cv_type",
    };
  }
  return { fileName, data, contentType, checksum: sha256(data) };
}

export interface ExpandResult {
  accepted: AcceptedCv[];
  skipped: SkippedFile[];
  /** Inflated + loose bytes counted against the batch budget. */
  acceptedBytes: number;
}

export function expandUpload(files: UploadedFile[], limits: ExpandLimits): ExpandResult {
  const accepted: AcceptedCv[] = [];
  const skipped: SkippedFile[] = [];
  let acceptedBytes = 0;

  const take = (cv: AcceptedCv) => {
    if (acceptedBytes + cv.data.length > limits.remainingBytes) {
      skipped.push({ fileName: cv.fileName, reason: "batch_size_exceeded" });
      return;
    }
    acceptedBytes += cv.data.length;
    accepted.push(cv);
  };

  for (const file of files) {
    const baseName = sanitiseDisplayPath(file.name.split(/[\\/]/).pop() ?? file.name);
    if (!isSafeArchivePath(baseName)) {
      skipped.push({ fileName: baseName || "(unnamed)", reason: "unsafe_path" });
      continue;
    }
    if (isJunkPath(baseName)) continue;

    if (isZipUpload(baseName, file.data)) {
      let result: ReturnType<typeof readZip>;
      const zipLimits: ZipLimits = {
        // The archive itself is bounded by what the batch can still take; its
        // inflated content is bounded the same way.
        maxArchiveBytes: limits.remainingBytes,
        maxEntries: limits.maxZipEntries,
        maxEntryBytes: limits.maxFileBytes,
        maxTotalBytes: Math.max(0, limits.remainingBytes - acceptedBytes),
      };
      try {
        result = readZip(file.data, zipLimits);
      } catch (err) {
        skipped.push({
          fileName: baseName,
          reason: err instanceof ZipArchiveError ? err.code : "corrupt_archive",
        });
        continue;
      }
      for (const s of result.skipped) {
        skipped.push({ fileName: `${baseName}/${s.path}`, reason: s.reason });
      }
      for (const entry of result.files) {
        const display = `${baseName}/${entry.path}`;
        const c = classify(entry.path, entry.data, limits.maxFileBytes);
        if ("skip" in c) skipped.push({ fileName: display, reason: c.skip });
        else take({ ...c, fileName: display });
      }
      continue;
    }

    const c = classify(baseName, file.data, limits.maxFileBytes);
    if ("skip" in c) skipped.push({ fileName: baseName, reason: c.skip });
    else take(c);
  }

  return { accepted, skipped, acceptedBytes };
}
