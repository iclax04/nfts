import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";
import { translateSql } from "../src/lib/mariadb-sql.ts";

function loadEnvFile() {
  try {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key]?.trim()) continue;
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log(
    "[migrate] DATABASE_URL not set — skipping (the app migrates itself on startup).",
  );
  process.exit(0);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function statementsOf(text) {
  return translateSql(text)
    .split(/;(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

async function migrateMysql(url) {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({
    uri: url,
    charset: "utf8mb4",
    timezone: "Z",
    connectTimeout: 8_000,
  });
  try {
    await conn.query(
      "SET SESSION sql_mode = CASE WHEN LOCATE('ANSI_QUOTES', @@SESSION.sql_mode) = 0 THEN CONCAT(@@SESSION.sql_mode, ',ANSI_QUOTES') ELSE @@SESSION.sql_mode END",
    );
    await conn.query("SET time_zone = '+00:00'");
    await conn.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name varchar(191) PRIMARY KEY, applied_at datetime(6) NOT NULL DEFAULT current_timestamp(6))",
    );
    const [appliedRows] = await conn.query("SELECT name FROM _migrations");
    const applied = appliedRows.map((row) => row.name);
    let entries;
    try {
      entries = await readdir(migrationsDir);
    } catch {
      console.log("[migrate] no migrations/ directory — nothing to do.");
      return;
    }
    let count = 0;
    for (const { name } of pendingMigrations(entries, applied)) {
      const text = await readFile(join(migrationsDir, name), "utf8");
      try {
        for (const statement of statementsOf(text)) await conn.query(statement);
        await conn.query("INSERT INTO _migrations (name) VALUES (?)", [name]);
      } catch (err) {
        console.error(`[migrate] error applying ${name}`);
        throw err;
      }
      console.log(`[migrate] applied ${name}`);
      count += 1;
    }
    console.log(count ? `[migrate] done — ${count} migration(s) applied.` : "[migrate] up to date.");
  } finally {
    await conn.end();
  }
}

async function migratePostgres(url) {
  let entries;
  try {
    entries = await readdir(migrationsDir);
  } catch {
    console.log("[migrate] no migrations/ directory — nothing to do.");
    return;
  }
  if (pendingMigrations(entries, []).length === 0) {
    console.log("[migrate] no migrations — nothing to do.");
    return;
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = (await client.query("SELECT name FROM _migrations")).rows.map((r) => r.name);

    let count = 0;
    for (const { name } of pendingMigrations(entries, applied)) {
      const text = await readFile(join(migrationsDir, name), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(text);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (err) {
        console.error(`[migrate] error applying ${name}`);
        try {
          await client.query("ROLLBACK");
        } catch {
          // ROLLBACK fails when the connection died — keep the original error.
        }
        throw err;
      }
      console.log(`[migrate] applied ${name}`);
      count += 1;
    }
    console.log(count ? `[migrate] done — ${count} migration(s) applied.` : "[migrate] up to date.");
  } finally {
    client.release();
    await pool.end();
  }
}

const mysqlUrl = databaseUrl.startsWith("mysql:") || databaseUrl.startsWith("mariadb:");
try {
  if (mysqlUrl) await migrateMysql(databaseUrl);
  else await migratePostgres(databaseUrl);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (mysqlUrl && /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Access denied/i.test(message)) {
    console.error(`[migrate] database unreachable during build (${message}). Schema will apply on startup.`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
}