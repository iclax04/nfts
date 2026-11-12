import { bindParams } from "./mariadb-sql.ts";

type Row = Record<string, unknown>;

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
  beginTransaction: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

type Column = { name: string; sqlType: string };

export type WithQuery = {
  ctes: { name: string; body: string }[];
  main: string;
};

function skipString(sql: string, index: number): number {
  let i = index + 1;
  while (i < sql.length) {
    if (sql[i] === "'" && sql[i + 1] === "'") {
      i += 2;
      continue;
    }
    if (sql[i] === "'") return i + 1;
    i += 1;
  }
  return i;
}

export function parseWith(sql: string): WithQuery | null {
  const trimmed = sql.trim();
  const start = trimmed.search(/\bwith\b/i);
  if (start !== 0) return null;
  let i = start + 4;
  const ctes: { name: string; body: string }[] = [];
  while (i < trimmed.length) {
    while (i < trimmed.length && /[\s,]/.test(trimmed[i])) i += 1;
    const nameMatch = /^([A-Za-z_][\w]*)\s+as\s*\(/i.exec(trimmed.slice(i));
    if (!nameMatch) return null;
    i += nameMatch[0].length;
    let depth = 1;
    const bodyAt = i;
    while (i < trimmed.length && depth > 0) {
      const char = trimmed[i];
      if (char === "'") {
        i = skipString(trimmed, i);
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      if (depth > 0) i += 1;
    }
    ctes.push({ name: nameMatch[1], body: trimmed.slice(bodyAt, i).trim() });
    i += 1;
    while (i < trimmed.length && /\s/.test(trimmed[i])) i += 1;
    if (trimmed[i] === ",") {
      i += 1;
      continue;
    }
    break;
  }
  const main = trimmed.slice(i).trim();
  if (!ctes.length || !main) return null;
  return { ctes, main };
}

function isDml(body: string): boolean {
  return /^(update|insert|delete)\b/i.test(body.trim());
}

function indexOfKeyword(sql: string, keyword: string, from = 0): number {
  const lower = keyword.toLowerCase();
  let depth = 0;
  for (let i = from; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") {
      i = skipString(sql, i) - 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (sql.slice(i, i + lower.length).toLowerCase() !== lower) continue;
    const before = i === 0 ? " " : sql[i - 1];
    const after = sql[i + lower.length] ?? " ";
    if (!/\w/.test(before) && !/\w/.test(after)) return i;
  }
  return -1;
}

function splitTop(src: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (char === "'") {
      i = skipString(src, i) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === sep && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

/** Postgres `UPDATE ... FROM ...` → MariaDB `UPDATE ... JOIN ...`. */
export function rewriteUpdateFrom(sql: string): string {
  if (!/^\s*update\b/i.test(sql)) return sql;
  const setAt = indexOfKeyword(sql, "set");
  if (setAt < 0) return sql;
  const fromAt = indexOfKeyword(sql, "from", setAt);
  if (fromAt < 0) return sql;
  const whereAt = indexOfKeyword(sql, "where", fromAt);
  const returningAt = indexOfKeyword(sql, "returning", fromAt);
  const endOfFrom = whereAt >= 0 ? whereAt : returningAt >= 0 ? returningAt : sql.length;
  const fromList = sql.slice(fromAt + 4, endOfFrom).trim();
  const joins = splitTop(fromList, ",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `JOIN ${item} ON 1=1`)
    .join(" ");
  const target = sql.slice(0, setAt).trim();
  const sets = sql.slice(setAt + 3, fromAt).trim();
  const rest = sql.slice(endOfFrom).trim();
  return `${target} ${joins} SET ${sets}${rest ? ` ${rest}` : ""}`;
}

function wordBefore(sql: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && /\s/.test(sql[i])) i -= 1;
  const end = i + 1;
  while (i >= 0 && /\w/.test(sql[i])) i -= 1;
  return sql.slice(i + 1, end).toLowerCase();
}

function renameCtes(sql: string, map: Map<string, string>): string {
  if (!map.size) return sql;
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const next = skipString(sql, i);
      out += sql.slice(i, next);
      i = next;
      continue;
    }
    if (/[A-Za-z_]/.test(sql[i]) && !/[\w.]/.test(sql[i - 1] ?? "")) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j])) j += 1;
      const word = sql.slice(i, j);
      const mapped = map.get(word) ?? map.get(word.toLowerCase());
      const prev = wordBefore(sql, i);
      out += mapped && prev !== "as" ? mapped : word;
      i = j;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

function safeName(name: string, index: number): string {
  return /^[A-Za-z_][\w]*$/.test(name) ? name : `c${index}`;
}

function inferType(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? "BIGINT" : "DECIMAL(24,8)";
  if (value instanceof Date) return "DATETIME(6)";
  return "TEXT";
}

function fieldType(typeNum: number): string {
  if ([1, 2, 3, 8, 9, 13].includes(typeNum)) return "BIGINT";
  if ([0, 4, 5, 246].includes(typeNum)) return "DECIMAL(24,8)";
  if ([7, 10, 12, 14].includes(typeNum)) return "DATETIME(6)";
  return "TEXT";
}

function outputColumns(sql: string): string[] {
  const at = indexOfKeyword(sql, "returning");
  if (at < 0) return ["c0"];
  return splitTop(sql.slice(at + "returning".length), ",").map((part, index) => {
    const text = part.trim();
    const alias = /^(.*)\s+as\s+([A-Za-z_][\w]*)$/i.exec(text);
    if (alias) return safeName(alias[2], index);
    const ident = /([A-Za-z_][\w]*)$/.exec(text);
    return safeName(ident?.[1] ?? `c${index}`, index);
  });
}

async function storeRows(conn: Queryable, table: string, rows: Row[], columns: Column[]) {
  const cols = columns.length ? columns : [{ name: "c0", sqlType: "INT" }];
  await conn.query(`DROP TEMPORARY TABLE IF EXISTS \`${table}\``);
  await conn.query(
    `CREATE TEMPORARY TABLE \`${table}\` (${cols.map((col) => `\`${col.name}\` ${col.sqlType}`).join(", ")})`,
  );
  if (!rows.length) return;
  const chunk = 200;
  for (let offset = 0; offset < rows.length; offset += chunk) {
    const slice = rows.slice(offset, offset + chunk);
    const placeholders = slice.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
    const values = slice.flatMap((row) => cols.map((col) => row[col.name] ?? null));
    await conn.query(
      `INSERT INTO \`${table}\` (${cols.map((col) => `\`${col.name}\``).join(",")}) VALUES ${placeholders}`,
      values,
    );
  }
}

function columnsFromFields(fields: { name?: string; type?: number }[] | undefined, sql: string): Column[] {
  if (fields?.length) {
    return fields.map((field, index) => ({
      name: safeName(String(field.name ?? `c${index}`), index),
      sqlType: fieldType(Number(field.type ?? 253)),
    }));
  }
  return outputColumns(sql).map((name) => ({ name, sqlType: "TEXT" }));
}

function rowsFromResult(result: unknown, columns: Column[]): Row[] {
  if (!Array.isArray(result)) return [];
  return result.map((row) => {
    const source = row as Row;
    const values = Object.values(source);
    const out: Row = {};
    columns.forEach((col, index) => {
      const original = Object.keys(source)[index];
      out[col.name] = original != null && original in source ? source[original] : values[index] ?? null;
    });
    return out;
  });
}

function assignedColumns(sets: string): { col: string; value: string }[] {
  return splitTop(sets, ",")
    .map((part) => {
      let depth = 0;
      for (let i = 0; i < part.length; i += 1) {
        const char = part[i];
        if (char === "'") {
          i = skipString(part, i) - 1;
          continue;
        }
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        else if (char === "=" && depth === 0) {
          return { col: part.slice(0, i).trim(), value: part.slice(i + 1).trim() };
        }
      }
      return null;
    })
    .filter((item): item is { col: string; value: string } => Boolean(item));
}

function substituteAssigned(expr: string, assignments: { col: string; value: string }[]): string {
  let next = expr;
  const ordered = [...assignments].sort((a, b) => b.col.length - a.col.length);
  for (const assignment of ordered) {
    const bare = assignment.col.split(".").pop() ?? assignment.col;
    if (!/^[A-Za-z_][\w]*$/.test(bare)) continue;
    const pattern = new RegExp(`\\b[A-Za-z_][\\w]*\\.${bare}\\b|(?<![.\\w])${bare}\\b`, "g");
    next = next.replace(pattern, `(${assignment.value})`);
  }
  return next;
}

function projectReturning(returning: string, assignments: { col: string; value: string }[]): string {
  return splitTop(returning, ",")
    .map((part, index) => {
      const text = part.trim();
      const aliasMatch = /^(.*)\s+as\s+([A-Za-z_][\w]*)$/i.exec(text);
      const expr = substituteAssigned(aliasMatch ? aliasMatch[1].trim() : text, assignments);
      const alias = aliasMatch
        ? aliasMatch[2]
        : safeName(/([A-Za-z_][\w]*)$/.exec(text)?.[1] ?? `c${index}`, index);
      return `${expr} as \`${alias}\``;
    })
    .join(", ");
}

async function queryRows(conn: Queryable, sql: string, params: unknown[]): Promise<Row[]> {
  const bound = bindParams(sql, params);
  const [result] = await conn.query(bound.text, bound.values);
  return Array.isArray(result) ? (result as Row[]) : [];
}

/** MariaDB has no `UPDATE ... RETURNING`. Project the new values, then update. */
export async function emulateUpdate(
  conn: Queryable,
  sql: string,
  params: unknown[],
  inTransaction: boolean,
): Promise<Row[]> {
  const rewritten = rewriteUpdateFrom(sql);
  const setAt = indexOfKeyword(rewritten, "set");
  const whereAt = indexOfKeyword(rewritten, "where", setAt);
  const returningAt = indexOfKeyword(rewritten, "returning", setAt);
  if (setAt < 0 || returningAt < 0) return queryRows(conn, rewritten, params);
  const fromClause = rewritten.slice(rewritten.search(/\bupdate\b/i) + 6, setAt).trim();
  const sets = rewritten.slice(setAt + 3, whereAt >= 0 ? whereAt : returningAt).trim();
  const where = whereAt >= 0 ? rewritten.slice(whereAt, returningAt).trim() : "";
  const returning = rewritten.slice(returningAt + "returning".length).trim();
  const projected = projectReturning(returning, assignedColumns(sets));
  const selectSql = `select ${projected} from ${fromClause} ${where} for update`.replace(/\s+/g, " ");
  const updateSql = rewritten.slice(0, returningAt).trim();
  if (!inTransaction) await conn.beginTransaction();
  try {
    const selected = await queryRows(conn, selectSql, params);
    const bound = bindParams(updateSql, params);
    const [header] = await conn.query(bound.text, bound.values);
    const affected = header && typeof header === "object" && "affectedRows" in header
      ? Number((header as { affectedRows: number }).affectedRows)
      : 0;
    if (!inTransaction) await conn.commit();
    return affected > 0 ? selected : [];
  } catch (error) {
    if (!inTransaction) await conn.rollback();
    throw error;
  }
}

async function materializeDml(conn: Queryable, table: string, body: string, params: unknown[]) {
  const rewritten = rewriteUpdateFrom(body);
  if (/^\s*update\b/i.test(rewritten) && indexOfKeyword(rewritten, "returning") >= 0) {
    const rows = await emulateUpdate(conn, rewritten, params, true);
    const columns = (rows[0] ? Object.keys(rows[0]) : outputColumns(rewritten)).map((name, index) => {
      const sample = rows.find((row) => row[name] != null)?.[name];
      return { name: safeName(name, index), sqlType: sample == null ? "TEXT" : inferType(sample) };
    });
    const stored = rows.map((row) => {
      const out: Row = {};
      columns.forEach((col, index) => {
        out[col.name] = row[Object.keys(row)[index]] ?? null;
      });
      return out;
    });
    await storeRows(conn, table, stored, columns);
    return;
  }
  const bound = bindParams(rewritten, params);
  const [result, fields] = await conn.query(bound.text, bound.values);
  const columns = columnsFromFields(fields as { name?: string; type?: number }[] | undefined, rewritten);
  await storeRows(conn, table, rowsFromResult(result, columns), columns);
}

async function execCtes(conn: Queryable, parsed: WithQuery, params: unknown[]): Promise<Row[]> {
  const map = new Map<string, string>();
  const temps: string[] = [];
  try {
    for (const cte of parsed.ctes) {
      const body = renameCtes(cte.body, map);
      const temp = `mq_${cte.name}`;
      map.set(cte.name, temp);
      map.set(cte.name.toLowerCase(), temp);
      temps.push(temp);
      if (isDml(body)) {
        await materializeDml(conn, temp, body, params);
      } else {
        const bound = bindParams(body, params);
        await conn.query(`DROP TEMPORARY TABLE IF EXISTS \`${temp}\``);
        await conn.query(`CREATE TEMPORARY TABLE \`${temp}\` AS ${bound.text}`, bound.values);
      }
    }
    return queryRows(conn, renameCtes(parsed.main, map), params);
  } finally {
    for (const temp of temps) {
      await conn.query(`DROP TEMPORARY TABLE IF EXISTS \`${temp}\``).catch(() => undefined);
    }
  }
}

function isUpdateReturning(sql: string): boolean {
  return /^\s*update\b/i.test(sql) && indexOfKeyword(sql, "returning") >= 0;
}

/** Run one app statement. Data-modifying WITH queries become temp tables. */
export async function executeMaria(
  conn: Queryable,
  translatedSql: string,
  params: unknown[],
  inTransaction: boolean,
): Promise<Row[]> {
  const parsed = parseWith(translatedSql);
  if (parsed?.ctes.some((cte) => isDml(cte.body))) {
    if (inTransaction) return execCtes(conn, parsed, params);
    await conn.beginTransaction();
    try {
      const rows = await execCtes(conn, parsed, params);
      await conn.commit();
      return rows;
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  }
  if (isUpdateReturning(translatedSql)) return emulateUpdate(conn, translatedSql, params, inTransaction);
  return queryRows(conn, translatedSql, params);
}
