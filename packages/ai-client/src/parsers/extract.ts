/**
 * Text extraction stage of the resume parser.
 *
 * Three paths:
 *   - application/pdf with a real text layer  → pdf-parse, source_format = 'pdf_text'
 *   - application/pdf without enough text     → OCR fallback, source_format = 'pdf_scanned'
 *   - application/vnd.openxml…wordprocessing  → mammoth, source_format = 'docx'
 *
 * Threshold: text layer with > 100 characters of non-whitespace content
 * is trusted. Below that we assume the "PDF" is really a scanned image
 * exported as PDF and run OCR.
 *
 * OCR is injectable via opts.ocr so tests don't have to load the
 * tesseract.js WASM + language model (~10MB cold).
 *
 * Returns ExtractionError (not throws) when the buffer can't be read or
 * the mime type isn't supported. The parser turns those into low-confidence
 * results rather than 500s — the apply form needs to be able to say
 * "we couldn't read this; please re-upload or fill manually."
 */

import { createRequire } from "node:module";
import type { SourceFormat } from "./resume-schema";

const requireFromHere = createRequire(import.meta.url);

export interface ExtractTextOpts {
  /** Override OCR for tests. Defaults to the real tesseract.js implementation. */
  ocr?: (buffer: Buffer) => Promise<string>;
  /** Override the text-layer threshold (chars). Defaults to 100. */
  textThreshold?: number;
}

export interface ExtractTextResult {
  text: string;
  sourceFormat: SourceFormat;
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

const DEFAULT_TEXT_THRESHOLD = 100;

const MIME_PDF = "application/pdf";
const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function extractText(
  buffer: Buffer,
  mimeType: string,
  opts: ExtractTextOpts = {},
): Promise<ExtractTextResult> {
  if (mimeType === MIME_PDF) {
    return extractPdf(buffer, opts);
  }
  if (mimeType === MIME_DOCX) {
    return extractDocx(buffer);
  }
  throw new ExtractionError(`Unsupported mime type: ${mimeType}`, { mimeType });
}

async function extractPdf(buffer: Buffer, opts: ExtractTextOpts): Promise<ExtractTextResult> {
  const threshold = opts.textThreshold ?? DEFAULT_TEXT_THRESHOLD;
  let textLayer: string;
  try {
    textLayer = await runPdfParse(buffer);
  } catch (err) {
    throw new ExtractionError(`PDF text-layer extraction failed: ${describe(err)}`, {
      cause: describe(err),
    });
  }
  if (textLayer.trim().length > threshold) {
    return { text: textLayer, sourceFormat: "pdf_text" };
  }
  // Fall through to OCR.
  const ocr = opts.ocr ?? runTesseractOcr;
  try {
    const ocrText = await ocr(buffer);
    return { text: ocrText, sourceFormat: "pdf_scanned" };
  } catch (err) {
    throw new ExtractionError(`OCR failed: ${describe(err)}`, { cause: describe(err) });
  }
}

async function extractDocx(buffer: Buffer): Promise<ExtractTextResult> {
  try {
    // mammoth pulls JSZip; CJS interop varies by bundler — keep it simple.
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, sourceFormat: "docx" };
  } catch (err) {
    throw new ExtractionError(`DOCX extraction failed: ${describe(err)}`, {
      cause: describe(err),
    });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runPdfParse(buffer: Buffer): Promise<string> {
  // pdf-parse's index.js tries to read a sample PDF at module load when
  // !module.parent (an ESM-hostile guard). Require the lib entry directly
  // to skip it. createRequire avoids the bundler asking tsc for a .d.ts
  // for this sub-path (no types exist).
  const pdfParse = requireFromHere("pdf-parse/lib/pdf-parse.js") as (
    b: Buffer,
  ) => Promise<{ text: string }>;
  const parsed = await pdfParse(buffer);
  return parsed.text;
}

async function runTesseractOcr(buffer: Buffer): Promise<string> {
  // Lazy import so tests that stub OCR don't pay the tesseract.js import
  // cost (it pulls a fairly large dependency tree).
  const tesseract = (await import("tesseract.js")) as unknown as {
    createWorker: (lang?: string) => Promise<{
      recognize: (input: Buffer) => Promise<{ data: { text: string } }>;
      terminate: () => Promise<void>;
    }>;
  };
  const worker = await tesseract.createWorker("eng");
  try {
    const { data } = await worker.recognize(buffer);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
