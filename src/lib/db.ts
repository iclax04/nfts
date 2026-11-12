import { readFileSync } from "node:fs";
import { pendingMigrations } from "../../scripts/migration-plan.mjs";
import { executeMaria } from "./mariadb-cte.ts";
import { translateSql } from "./mariadb-sql.ts";

const HOSTINGER_URL =
  "mysql://u221518716_support:China246%40%23@srv1816.hstgr.io:3306/u221518716_nfts";

function readDotEnvDatabaseUrl(): string | undefined {
  try {
    const text = readFileSync("/workspace/.env", "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith("DATABASE_URL=")) continue;
      let value = trimmed.slice("DATABASE_URL=".length).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || undefined;
    }
  } catch {
    /* Hosting can set DATABASE_URL in the environment. */
  }
  return undefined;
}

/** Marketplace data lives on Hostinger MariaDB, even when deploy injects Postgres. */
export function resolveDatabaseUrl(): string | undefined {
  const fromFile = readDotEnvDatabaseUrl();
  const fromEnv = process.env.DATABASE_URL?.trim();
  for (const value of [fromFile, fromEnv]) {
    if (value?.startsWith("mysql:") || value?.startsWith("mariadb:")) return value;
  }
  if (!fromEnv || /^postgres(ql)?:/i.test(fromEnv)) return HOSTINGER_URL;
  return fromEnv;
}

const resolvedDatabaseUrl = resolveDatabaseUrl();
if (resolvedDatabaseUrl) process.env.DATABASE_URL = resolvedDatabaseUrl;

/** Which database backend is active. */
export type DbSource = "neon" | "pglite" | "mariadb";

// An empty/whitespace DATABASE_URL (an easy misconfig in deploy UIs) must mean
// "unset" — otherwise production would silently run on the PGLite fallback.
const rawDatabaseUrl =
  typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
const databaseUrl =
  rawDatabaseUrl && rawDatabaseUrl.trim() ? rawDatabaseUrl : undefined;

/**
 * Active backend: real **Neon** when `DATABASE_URL` is set (deployed / configured
 * sandbox), otherwise a local embedded **PGLite** (Postgres compiled to WASM) so
 * the app has a working database even with nothing configured — the live preview
 * included. Swap in Neon later by just setting `DATABASE_URL`; no code changes.
 */
const mariadb = Boolean(databaseUrl?.startsWith("mysql:") || databaseUrl?.startsWith("mariadb:"));
export const dbSource: DbSource = mariadb ? "mariadb" : databaseUrl ? "neon" : "pglite";

/**
 * Minimal shared SQL surface, satisfied by both Neon and PGLite. Both the
 * tagged-template and `.query()` forms resolve to an array of row objects:
 *
 *   const sql = await getSql();
 *   const rows = await sql`select * from todos where id = ${id}`; // parameterized
 *   const rows2 = await sql.query("select * from todos where id = $1", [id]);
 */
export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

/**
 * Init state lives on globalThis as promises: dev HMR creates new instances of
 * this module, and two instances racing module-level state would open a second
 * pool or run two concurrent PGLite migration passes (whose duplicate
 * `_migrations` insert rejects — and would get memoized, poisoning every later
 * `getSql()`). A failed init clears its slot so the next call retries.
 */
const globalRef = globalThis as typeof globalThis & {
  __pgSqlPromise__?: Promise<Sql>;
  __pgliteInstance__?: Promise<import("@electric-sql/pglite").PGlite>;
  __pgliteMigrateChain__?: Promise<void>;
};

/**
 * Result-type parity: Postgres sends every value as text plus a type OID — the
 * JS value is the DRIVER's parsing choice, and pg and PGLite disagree (pg:
 * int8 -> string, date -> local-midnight Date; PGLite: int8 -> BigInt, which
 * JSON.stringify rejects, date -> UTC Date). Normalize both so preview and
 * production return identical, JSON-safe shapes:
 *   int8/bigint (incl. count(*)) -> number (past 2^53 loses precision — cast
 *                                   `::text` if you ever need huge integers)
 *   date                         -> 'YYYY-MM-DD' string
 *   interval                     -> Postgres interval text
 * numeric already comes back as a string on both (arbitrary precision).
 */
const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
function toSql(run: Run, transaction?: Sql["transaction"]): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Rebuild with $1, $2, … placeholders so values stay parameterized.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  sql.transaction = transaction ?? (async (fn) => fn(sql));
  return sql;
}

function createNeonSql(): Promise<Sql> {
  globalRef.__pgSqlPromise__ ??= (async () => {
    // Regular Postgres driver: node-postgres (`pg`) — works directly with Neon's
    // pooled endpoint. One pool per process; warm serverless instances reuse it.
    const { Pool, types } = await import("pg");
    types.setTypeParser(OID_INT8, Number);
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);
    const pool = new Pool({ connectionString: databaseUrl });
    return toSql(async <T>(text: string, params: unknown[]) => {
      const res = await pool.query(text, params);
      return res.rows as T[];
    });
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgSqlPromise__;
}

async function createPgliteSql(): Promise<Sql> {
  // Embedded Postgres. New files in /migrations apply when this module reloads.
  // One instance per process, shared across HMR. Prefer a writable temp dir so
  // accounts survive a dev-server restart. Hosted runtimes (Vercel) cannot
  // create /workspace/data — a failed mkdir must fall back to memory instead of
  // surfacing EACCES on the page. Production uses MariaDB/Neon when configured.
  globalRef.__pgliteInstance__ ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const candidates = [
      process.env.PGLITE_DATA_DIR?.trim(),
      join(tmpdir(), "agora-pglite"),
    ].filter((dir): dir is string => Boolean(dir));
    let dataDir = "memory://";
    for (const dir of candidates) {
      try {
        mkdirSync(dir, { recursive: true });
        dataDir = dir;
        break;
      } catch (err) {
        console.error("[db] PGLite data dir not writable, trying next:", dir, err);
      }
    }
    const pg = new PGlite({
      dataDir,
      parsers: {
        [OID_INT8]: Number,
        [OID_DATE]: identity,
        [OID_INTERVAL]: identity,
      },
    });
    await pg.waitReady;
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    return pg;
  })().catch((err) => {
    globalRef.__pgliteInstance__ = undefined;
    throw err;
  });
  const pg = await globalRef.__pgliteInstance__;

  // Apply migrations/ (the single schema source) so preview matches production.
  // SQL is inlined by the bundler via import.meta.glob (no runtime fs); applied
  // files are tracked in _migrations. The glob does not descend, so the opt-in
  // auth schema under migrations/auth/ stays out. Runs once per module instance
  // — so an HMR reload after adding a migration file applies it live — with
  // passes serialized on a global chain so concurrent callers never
  // double-apply.
  const migrate = async (): Promise<void> => {
    const migrations = import.meta.glob("/migrations/*.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const doneRows = await pg.query<{ name: string }>(
      "select name from _migrations",
    );
    const done = doneRows.rows.map((r) => r.name);
    for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
      // Apply + record atomically (parity with scripts/migrate.mjs) so a failed
      // statement can't leave a file half-applied but untracked.
      await pg.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
  };
  const pass = (globalRef.__pgliteMigrateChain__ ?? Promise.resolve())
    .catch(() => undefined) // an earlier failed pass must not wedge the chain
    .then(migrate);
  globalRef.__pgliteMigrateChain__ = pass;
  await pass;

  return toSql(async <T>(text: string, params: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  });
}

let sqlPromise: Promise<Sql> | null = null;

async function prepareMaria(conn: { query: (sql: string) => Promise<unknown> } & { __agoraReady?: boolean }) {
  if (conn.__agoraReady) return;
  await conn.query(
    "SET SESSION sql_mode = CASE WHEN LOCATE('ANSI_QUOTES', @@SESSION.sql_mode) = 0 THEN CONCAT(@@SESSION.sql_mode, ',ANSI_QUOTES') ELSE @@SESSION.sql_mode END",
  );
  await conn.query("SET time_zone = '+00:00'");
  conn.__agoraReady = true;
}

async function createMariaSql(): Promise<Sql> {
  globalRef.__pgSqlPromise__ ??= (async () => {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool({
      uri: databaseUrl,
      connectionLimit: 8,
      charset: "utf8mb4",
      timezone: "Z",
      waitForConnections: true,
    });
    const runOn = async <T>(
      conn: {
        query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
        beginTransaction: () => Promise<void>;
        commit: () => Promise<void>;
        rollback: () => Promise<void>;
        __agoraReady?: boolean;
      },
      text: string,
      params: unknown[],
      inTransaction: boolean,
    ): Promise<T[]> => {
      await prepareMaria(conn);
      const rows = await executeMaria(conn, translateSql(text), params, inTransaction);
      return rows as T[];
    };
    const sql = toSql(async <T>(text: string, params: unknown[]) => {
      const conn = await pool.getConnection();
      try {
        return await runOn<T>(conn, text, params, false);
      } finally {
        conn.release();
      }
    });
    sql.transaction = async (fn) => {
      const conn = await pool.getConnection();
      const tx = toSql(async <T>(text: string, params: unknown[] = []) => runOn<T>(conn, text, params, true));
      try {
        await prepareMaria(conn);
        await conn.beginTransaction();
        const result = await fn(tx);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }
    };
    const conn = await pool.getConnection();
    try {
      await prepareMaria(conn);
      await conn.query(
        "create table if not exists _migrations (name varchar(191) primary key, applied_at datetime(6) not null default current_timestamp(6))",
      );
      const migrations = import.meta.glob("/migrations/*.sql", {
        query: "?raw",
        import: "default",
        eager: true,
      }) as Record<string, string>;
      const [doneRows] = await conn.query("select name from _migrations");
      const done = (Array.isArray(doneRows) ? doneRows : []).map((row) => String((row as { name: string }).name));
      for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
        const statements = translateSql(migrations[path])
          .split(/;(?=(?:[^']*'[^']*')*[^']*$)/)
          .map((part) => part.trim())
          .filter(Boolean);
        try {
          for (const statement of statements) await conn.query(statement);
          await conn.query("insert into _migrations (name) values (?)", [name]);
        } catch (error) {
          console.error(`[db] MariaDB migration failed: ${name}`);
          throw error;
        }
      }
    } finally {
      conn.release();
    }
    return sql;
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgSqlPromise__;
}

async function createSql(): Promise<Sql> {
  if (typeof window !== "undefined") {
    throw new Error(
      "@/lib/db is server-only — call getSql() from a createServerFn handler " +
        "or a server route loader, never from client code.",
    );
  }
  if (dbSource === "mariadb") return createMariaSql();
  return dbSource === "neon" ? createNeonSql() : createPgliteSql();
}

/**
 * Get the shared, **server-only** SQL client. Neon when `DATABASE_URL` is set,
 * otherwise the local PGLite fallback. Memoized — safe to call per request.
 *
 * Schema comes from `migrations/*.sql`, auto-applied before the first query on
 * both backends — define tables there, never inline in server functions.
 */
export function getSql(): Promise<Sql> {
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null; // don't memoize failures — let the next call retry
    throw err;
  });
  return sqlPromise;
}

/**
 * The shared PGLite instance (preview only), with `migrations/*.sql` applied.
 * Lets Better Auth persist to the SAME embedded DB as app data in preview (via a
 * Kysely dialect). Throws when `DATABASE_URL` is set (that path uses Neon).
 */
export async function getPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  if (dbSource !== "pglite") {
    throw new Error("getPglite() is only available on the PGLite fallback (no DATABASE_URL)");
  }
  await getSql();
  const pg = await globalRef.__pgliteInstance__;
  if (!pg) throw new Error("PGLite instance failed to initialize");
  return pg;
}

/**
 * Finish DB bootstrap before the server handles traffic.
 *
 * - **PGLite** (preview / no `DATABASE_URL`): open the in-memory DB and apply
 *   `migrations/*.sql`. Idempotent — concurrent callers share one promise.
 * - **Neon**: no-op (pool is created lazily on first query).
 *
 * Vite `configureServer` awaits this at dev startup; production imports of this
 * module kick it off immediately (see bottom of file).
 */
export function ensureDbReady(): Promise<void> {
  if (dbSource === "neon") return Promise.resolve();
  return getSql().then(() => undefined);
}

// Server-only eager start: kick PGLite bootstrap as soon as this module loads in
// Node. Client bundles never hit this path (`getSql` throws in the browser).
const globalBoot = globalThis as typeof globalThis & {
  __pgBootstrapPromise__?: Promise<void>;
};
if (typeof window === "undefined" && dbSource !== "neon") {
  globalBoot.__pgBootstrapPromise__ ??= ensureDbReady().catch((err) => {
    globalBoot.__pgBootstrapPromise__ = undefined;
    console.error("[db] database bootstrap failed:", err);
    throw err;
  });
}
