import type { Transcript } from "../desktop/contracts";

interface TimingRow {
  label: "geminiTiming" | "geminiAttemptTiming" | "speechTiming" | "cleanupTiming" | "totalTiming";
  ms: number;
}

/** Gemini measures one combined call; fallback stages have their own local timings. */
export function processingTimings(item: Transcript): TimingRow[] {
  const rows: TimingRow[] = [];
  if (item.timings.geminiMs !== undefined)
    rows.push({
      label: item.actualProfile === "gemini" ? "geminiTiming" : "geminiAttemptTiming",
      ms: item.timings.geminiMs,
    });
  if (item.actualProfile !== "gemini")
    rows.push(
      { label: "speechTiming", ms: item.timings.asrMs },
      { label: "cleanupTiming", ms: item.timings.cleanupMs }
    );
  rows.push({ label: "totalTiming", ms: item.timings.totalMs });
  return rows;
}
