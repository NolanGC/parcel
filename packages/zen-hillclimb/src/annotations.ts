// The ledger: what a person thought of what Zen produced.
//
// Append-only JSONL, committed to the repo, in the same spirit as
// perf/ledger.jsonl. Append-only because the point is the trail: a message
// marked bad, then fixed, then marked good is the record of a rule improving,
// and rewriting the earlier line would erase the only evidence the change did
// anything.
//
// This file is also the interface to the next session. A model picking the
// work back up reads the bad verdicts at the current hash, fixes what they
// describe, and leaves the ledger for the human to re-annotate.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type Verdict = "good" | "meh" | "bad";

export type Annotation = Readonly<{
  at: string;
  messageId: string;
  subject: string;
  zenVersion: string;
  zenHash: string;
  commit: string;
  dirty: boolean;
  verdict: Verdict;
  note: string;
}>;

const LEDGER = join(dirname(import.meta.dir), "annotations.jsonl");

const isVerdict = (value: unknown): value is Verdict =>
  value === "good" || value === "meh" || value === "bad";

const parse = (line: string): Annotation | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record["messageId"] !== "string") return undefined;
    if (!isVerdict(record["verdict"])) return undefined;
    return {
      at: String(record["at"] ?? ""),
      messageId: record["messageId"],
      subject: String(record["subject"] ?? ""),
      zenVersion: String(record["zenVersion"] ?? ""),
      zenHash: String(record["zenHash"] ?? ""),
      commit: String(record["commit"] ?? ""),
      dirty: record["dirty"] === true,
      verdict: record["verdict"],
      note: String(record["note"] ?? ""),
    };
  } catch {
    // A half-written line from an interrupted append shouldn't cost the whole
    // ledger, and there is nothing to recover from it.
    return undefined;
  }
};

export const readAll = async (): Promise<ReadonlyArray<Annotation>> => {
  if (!existsSync(LEDGER)) return [];
  const text = await Bun.file(LEDGER).text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parse)
    .filter((record): record is Annotation => record !== undefined);
};

export const append = async (record: Annotation): Promise<void> => {
  const existing = existsSync(LEDGER) ? await Bun.file(LEDGER).text() : "";
  await Bun.write(LEDGER, `${existing}${JSON.stringify(record)}\n`);
};

/** The latest verdict per message, which is what the list rail shows. */
export const latestByMessage = (
  records: ReadonlyArray<Annotation>,
): ReadonlyMap<string, Annotation> =>
  records.reduce((latest, record) => {
    latest.set(record.messageId, record);
    return latest;
  }, new Map<string, Annotation>());
