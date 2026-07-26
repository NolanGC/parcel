// SQL against the real local store, without a browser.
//
//   bun sql                                   # REPL
//   bun sql "SELECT COUNT(*) FROM threads"    # one shot
//   bun sql --file probe.sql                  # every statement in a file
//   bun sql --tables                          # size breakdown by table
//   bun sql --refresh ...                     # re-extract before querying
//   bun sql --wipe [--force]                  # empty the store (Parcel tab closed)
//
// The store is SQLite-WASM on OPFS, so there is no file to open directly:
// Chrome keeps it inside the profile under an AccessHandlePoolVFS, which
// packs databases into fixed pool files behind a 4KB header naming the
// database it currently holds. This finds the pool file whose header says
// `/parcel.sqlite`, copies it past the header into a snapshot, and queries
// that with bun:sqlite.
//
// The snapshot is a point-in-time copy, so writes made after extraction
// aren't visible — pass --refresh to take a fresh one. Reading while Chrome
// is mid-write can produce a torn copy, which `PRAGMA quick_check` catches
// on extraction rather than letting it surface as confusing results.

import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DB_NAME = "parcel.sqlite";
const HEADER_BYTES = 4096;
const snapshotPath = resolve("/tmp", `${DB_NAME}.snapshot`);

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(name);

const chromeRoot =
  arg("--chrome") ?? resolve(homedir(), "Library/Application Support/Google/Chrome");

// Which Chrome profile holds the app's origin. Every profile has a
// QuotaManager listing the storage keys it has buckets for, which is far
// cheaper than scanning profiles for the database itself.
const findProfile = (origin: string): string | undefined => {
  const candidates = ["Default", ...Array.from({ length: 12 }, (_, i) => `Profile ${i + 1}`)];
  for (const profile of candidates) {
    const quota = resolve(chromeRoot, profile, "WebStorage/QuotaManager");
    if (!existsSync(quota)) continue;
    const copy = `/tmp/quota-${profile.replace(/\s/g, "")}.db`;
    try {
      copyFileSync(quota, copy);
      const db = new Database(copy, { readonly: true });
      const table = db
        .query(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((row: { name: string }) => row.name)
        .find((name) => /bucket/i.test(name));
      if (table === undefined) continue;
      const hit = db
        .query(`SELECT storage_key FROM ${table}`)
        .all()
        .some((row: { storage_key?: string }) => row.storage_key === origin);
      db.close();
      if (hit) return profile;
    } catch {
      continue;
    }
  }
  return undefined;
};

// The pool file whose header names our database. Headers are the first
// HEADER_BYTES of each pool file, so this reads 4KB per candidate rather
// than sniffing whole multi-gigabyte files.
const poolFileName = (path: string): string | undefined => {
  try {
    if (!statSync(path).isFile()) return undefined;
    const header = readFileSync(path, { flag: "r" }).subarray(0, HEADER_BYTES);
    return new TextDecoder().decode(header).replace(/\0+.*$/s, "");
  } catch {
    return undefined;
  }
};

const poolFiles = (profile: string, matches: (name: string) => boolean): Array<string> => {
  const root = resolve(chromeRoot, profile, "File System");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((entry) => resolve(root, entry))
    .filter((path) => {
      const name = poolFileName(path);
      return name !== undefined && matches(name);
    });
};

const findPoolFile = (profile: string): string | undefined =>
  poolFiles(profile, (name) => name === `/${DB_NAME}` || name === DB_NAME)[0];

const extract = (origin: string): void => {
  const profile = findProfile(origin);
  if (profile === undefined) {
    throw new Error(
      `No Chrome profile has storage for ${origin}. Load the app once, or pass --origin.`,
    );
  }
  const pool = findPoolFile(profile);
  if (pool === undefined) {
    throw new Error(`Found profile "${profile}" but no pool file holding ${DB_NAME}.`);
  }
  console.error(`# ${profile} → ${pool}`);
  writeFileSync(snapshotPath, readFileSync(pool).subarray(HEADER_BYTES));

  const db = new Database(snapshotPath, { readonly: true });
  const check = Object.values(db.query("PRAGMA quick_check").get() as object)[0];
  db.close();
  if (check !== "ok") {
    throw new Error(
      `Snapshot failed integrity check (${String(check)}). Chrome was probably ` +
        `mid-write — retry, or quit Chrome for a clean copy.`,
    );
  }
};

// Empty the store, for real: `bun sql --wipe`.
//
// AccessHandlePoolVFS names a database in a pool file's 4KB header; zeroing
// the header is what un-associates the file, and truncating to the header is
// what gives the disk space back. That is the same thing the VFS does
// internally when a database is deleted, which is why it is safe to do from
// outside — and it is the only way to do it from outside, since OPFS has no
// path on the filesystem the app can be pointed at.
//
// What must not be open is the *app's tab*, not Chrome itself: the exclusive
// access handles belong to the page's worker and are released when it closes.
// Chrome running with the tab shut is fine, which is the common case — hence
// --force rather than a blanket refusal.
//
// The real tripwire is the mtime. A live VFS writes constantly during a
// backfill, so a pool file touched seconds ago means something still has it
// open, and rewriting it there is how you get a half-erased database instead
// of an empty one. That check is not skippable.
const QUIESCENT_MS = 10_000;

const wipe = (origin: string): void => {
  if (spawnSync("pgrep", ["-x", "Google Chrome"]).status === 0 && !flag("--force")) {
    throw new Error(
      "Chrome is running. Close the Parcel tab and re-run with --force " +
        "(quitting Chrome entirely also works). The access handles belong to " +
        "the tab, not the browser — this refuses by default because it cannot " +
        "see which tabs are open.",
    );
  }

  const profile = findProfile(origin);
  if (profile === undefined) {
    throw new Error(`No Chrome profile has storage for ${origin}.`);
  }
  // Everything the VFS mapped for us, not just the main database: SQLite's
  // journal is its own pool file, and leaving it behind would have the next
  // boot roll back into a database that no longer exists.
  const targets = poolFiles(profile, (name) => name.replace(/^\//, "").startsWith(DB_NAME));
  if (targets.length === 0) {
    console.error(`# ${profile}: nothing to wipe (no pool file holds ${DB_NAME})`);
    return;
  }

  const busy = targets.filter(
    (path) => Date.now() - statSync(path).mtimeMs < QUIESCENT_MS,
  );
  if (busy.length > 0) {
    throw new Error(
      `${busy.length} pool file(s) were written within the last ` +
        `${QUIESCENT_MS / 1000}s — the app still has the store open. Close the ` +
        `Parcel tab and re-run.`,
    );
  }

  const blank = new Uint8Array(HEADER_BYTES);
  for (const path of targets) {
    const before = statSync(path).size;
    const name = poolFileName(path);
    writeFileSync(path, blank);
    console.error(
      `# ${profile}: cleared ${name} — ${(before / 1048576).toFixed(1)} MB reclaimed`,
    );
  }
  if (existsSync(snapshotPath)) rmSync(snapshotPath);
  console.error("# done. Next load re-runs migrations against an empty store.");
};

const open = (): Database => {
  const origin = arg("--origin") ?? "http://localhost:1337/";
  if (flag("--refresh") || !existsSync(snapshotPath)) extract(origin);
  else {
    const age = (Date.now() - statSync(snapshotPath).mtimeMs) / 60_000;
    console.error(`# snapshot ${age.toFixed(0)}m old (--refresh to re-extract)`);
  }
  return new Database(snapshotPath, { readonly: true });
};

// BLOBs print as their size: a bare SELECT over message_bodies would
// otherwise pour megabytes into the terminal.
const cell = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === "string" && value.length > 80) return `${value.slice(0, 77)}…`;
  return value;
};

const run = (db: Database, query: string): void => {
  const trimmed = query.trim().replace(/;$/, "");
  if (trimmed === "") return;
  const started = performance.now();
  try {
    const rows = db.query(trimmed).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) console.log("(no rows)");
    else {
      console.table(
        rows.slice(0, 50).map((row) =>
          Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)])),
        ),
      );
      if (rows.length > 50) console.log(`… ${rows.length - 50} more rows`);
    }
    console.log(`  ${(performance.now() - started).toFixed(1)}ms`);
  } catch (error) {
    console.error(`  ${String(error).split("\n")[0]}`);
  }
};

// Where the bytes actually are — the question that motivated this tool.
const tableReport = (db: Database): void => {
  const pageSize = Object.values(db.query("PRAGMA page_size").get() as object)[0] as number;
  const pageCount = Object.values(db.query("PRAGMA page_count").get() as object)[0] as number;
  const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

  const tables = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as Array<{ name: string }>;

  const rows = tables.map(({ name }) => {
    const count = (db.query(`SELECT COUNT(*) n FROM "${name}"`).get() as { n: number }).n;
    // Sum the widest text/blob columns: an honest approximation of payload
    // bytes without pulling in dbstat, which isn't compiled into bun's SQLite.
    const columns = (db.query(`PRAGMA table_info("${name}")`).all() as Array<{
      name: string;
      type: string;
    }>).filter((column) => /TEXT|BLOB/i.test(column.type));
    const bytes = columns.reduce((total, column) => {
      const sum = (
        db.query(`SELECT COALESCE(SUM(LENGTH("${column.name}")),0) n FROM "${name}"`).get() as {
          n: number;
        }
      ).n;
      return total + sum;
    }, 0);
    return { table: name, rows: count.toLocaleString(), payload: mb(bytes), _b: bytes };
  });

  rows.sort((a, b) => b._b - a._b);
  console.table(rows.map(({ _b, ...rest }) => rest));
  console.log(`file ${mb(pageCount * pageSize)}`);
};

const main = async (): Promise<void> => {
  if (flag("--wipe")) {
    return wipe(arg("--origin") ?? "http://localhost:1337/");
  }

  const db = open();
  try {
    if (flag("--tables")) return tableReport(db);

    const file = arg("--file");
    if (file !== undefined) {
      for (const statement of readFileSync(resolve(file), "utf8").split(";")) {
        if (statement.trim() === "") continue;
        console.log(`\n> ${statement.trim()}`);
        run(db, statement);
      }
      return;
    }

    const flags = new Set(["--file", "--origin", "--chrome"]);
    const inline = process.argv
      .slice(2)
      .filter((value, index, all) => {
        const previous = all[index - 1];
        return (
          !value.startsWith("--") && !(previous !== undefined && flags.has(previous))
        );
      })
      .join(" ");

    if (inline !== "") return run(db, inline);

    console.log("Connected. One statement per line, Ctrl-C to exit.\n");
    process.stdout.write("> ");
    for await (const line of console) {
      run(db, line);
      process.stdout.write("> ");
    }
  } finally {
    db.close();
  }
};

await main();
