import type { RunSummary } from '../summarizer/summarizer.js';
import type { VisionStats } from '../extract/vision-fallback.js';

/**
 * Context passed to writers containing file paths and run metadata.
 */
export interface WriteContext {
  runId: string;
  runDir: string;
  rawJsonPath: string;
  summaryJsonPath: string;
  displayRawJsonPath?: string;
  displaySummaryJsonPath?: string;
  visionStats?: VisionStats;
}

/**
 * Receipt returned by a writer indicating success or failure.
 */
export type WriteReceipt =
  | { ok: true; kind: 'file' | 'notion'; displayLocation: string }
  | { ok: false; reason: string };

/**
 * Writer interface - all destinations implement this.
 */
export interface Writer {
  /** Short identifier used in logs, e.g. "markdown", "notion". */
  readonly id: string;

  /** Render + persist. Must NOT throw — all failures return ok:false. */
  write(summary: RunSummary, context: WriteContext): Promise<WriteReceipt>;
}

/**
 * Result from running multiple writers.
 */
export interface RunWritersResult {
  receipts: Array<{ id: string; receipt: WriteReceipt }>;
  markdownSucceeded: boolean;
  anySucceeded: boolean;
}

/**
 * Run multiple writers sequentially, collecting their receipts.
 * Never throws - writers that throw are caught and converted to failure receipts.
 */
export async function runWriters(params: {
  writers: Writer[];
  summary: RunSummary;
  context: WriteContext;
}): Promise<RunWritersResult> {
  const { writers, summary, context } = params;
  const receipts: Array<{ id: string; receipt: WriteReceipt }> = [];

  for (const writer of writers) {
    let receipt: WriteReceipt;

    try {
      receipt = await writer.write(summary, context);
    } catch (error: any) {
      // Defensive: writer threw instead of returning { ok: false }
      receipt = {
        ok: false,
        reason: error.message || 'Unknown error',
      };
    }

    receipts.push({ id: writer.id, receipt });
  }

  // Determine markdown success (id === 'markdown' and ok === true)
  const markdownSucceeded = receipts.some(
    r => r.id === 'markdown' && r.receipt.ok === true
  );

  // Determine if any writer succeeded
  const anySucceeded = receipts.some(r => r.receipt.ok === true);

  return {
    receipts,
    markdownSucceeded,
    anySucceeded,
  };
}
