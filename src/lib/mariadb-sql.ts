const CAST: Record<string, string> = {
  text: "CHAR",
  numeric: "DECIMAL(18,6)",
  timestamptz: "DATETIME(6)",
  int: "SIGNED",
  integer: "SIGNED",
  boolean: "SIGNED",
};

const INTERVAL_UNIT: Record<string, string> = {
  minute: "MINUTE",
  minutes: "MINUTE",
  hour: "HOUR",
  hours: "HOUR",
  day: "DAY",
  days: "DAY",
  second: "SECOND",
  seconds: "SECOND",
};

const WIDE_TEXT = new Set([
  "bio", "description", "image_url", "media_url", "blurb", "detail", "note", "body",
  "avatar_url", "message", "value", "accessToken", "refreshToken", "idToken", "scope",
  "password", "userAgent", "featured_title", "tagline", "announcement", "href",
  "image", "reason", "site_url", "reject_reason", "old_value", "new_value", "password_hash",
]);

function splitStatements(sql: string): string[] {
  return sql.split(/;(?=(?:[^']*'[^']*')*[^']*$)/);
}

function takeExpr(value: string): string {
  let index = value.length - 1;
  if (index < 0) return "";
  if (value[index] === ")") {
    let depth = 0;
    for (; index >= 0; index -= 1) {
      if (value[index] === ")") depth += 1;
      else if (value[index] === "(") {
        depth -= 1;
        if (depth === 0) {
          let name = index - 1;
          while (name >= 0 && /[\w.$]/.test(value[name])) name -= 1;
          return value.slice(name + 1);
        }
      }
    }
  }
  if (value[index] === "'") {
    const end = index;
    index -= 1;
    while (index >= 0 && value[index] !== "'") index -= 1;
    return value.slice(index, end + 1);
  }
  const end = value.length;
  while (index >= 0 && /[\w.$]/.test(value[index])) index -= 1;
  return value.slice(index + 1, end);
}

function wrapCasts(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i += 1) {
    const match = /^::(text|numeric|timestamptz|integer|int|boolean)\b/i.exec(sql.slice(i));
    if (match) {
      const expr = takeExpr(out);
      out = `${out.slice(0, out.length - expr.length)}CAST(${expr} AS ${CAST[match[1].toLowerCase()]})`;
      i += match[0].length - 1;
      continue;
    }
    out += sql[i];
  }
  return out;
}

function replaceFilters(sql: string): string {
  const re = /\b(sum|count|avg|min|max)\(([^()]*)\)\s+filter\s*\(\s*where\s+/gi;
  let out = "";
  let last = 0;
  for (const match of sql.matchAll(re)) {
    const start = match.index ?? 0;
    const from = start + match[0].length;
    let depth = 1;
    let end = from;
    for (; end < sql.length && depth > 0; end += 1) {
      if (sql[end] === "(") depth += 1;
      else if (sql[end] === ")") depth -= 1;
    }
    const where = sql.slice(from, end - 1);
    out += sql.slice(last, start);
    out += `${match[1]}(CASE WHEN ${where} THEN ${match[2]} END)`;
    last = end;
  }
  return out + sql.slice(last);
}

function rewriteStatement(stmt: string): string {
  if (/^\s*select\s+setval\b/i.test(stmt)) return "";
  if (/^\s*create\s+unique\s+index\b/i.test(stmt) && /\bwhere\b/i.test(stmt)) return "";
  if (!/\bon\s+conflict\b/i.test(stmt)) return stmt;
  if (/\bdo\s+nothing\b/i.test(stmt)) {
    return stmt
      .replace(/\s+on\s+conflict(\s*\([^)]*\))?\s+do\s+nothing/gi, "")
      .replace(/\binsert\s+into\b/i, "INSERT IGNORE INTO");
  }
  if (/\bdo\s+update\s+set\b/i.test(stmt)) {
    return stmt
      .replace(/\s+on\s+conflict(\s*\([^)]*\))?\s+do\s+update\s+set\s+/i, " ON DUPLICATE KEY UPDATE ")
      .replace(/\bexcluded\.([A-Za-z_][\w]*)/gi, "VALUES($1)");
  }
  return stmt;
}

function splitTop(src: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (inString) {
      if (char === "'" && src[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") {
      inString = true;
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

function splitTuples(src: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (inString) {
      if (char === "'" && src[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") {
      inString = true;
      continue;
    }
    if (char === "(") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        tuples.push(src.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return tuples;
}

/** Postgres `VALUES (...) AS v(a, b)` → a union that MariaDB can join. */
function rewriteValues(sql: string): string {
  let out = "";
  let cursor = 0;
  const marker = /\)\s*as\s+([A-Za-z_][\w]*)\s*\(([^)]+)\)/gi;
  for (const match of sql.matchAll(marker)) {
    const cols = match[2].split(",").map((col) => col.trim()).filter(Boolean);
    if (cols.length < 2 || match.index == null) continue;
    let depth = 0;
    let open = -1;
    for (let i = match.index; i >= 0; i -= 1) {
      const char = sql[i];
      if (char === ")") depth += 1;
      else if (char === "(") {
        depth -= 1;
        if (depth === 0) {
          open = i;
          break;
        }
      }
    }
    if (open < 0) continue;
    const inner = sql.slice(open + 1, match.index);
    const valuesAt = inner.search(/\bvalues\b/i);
    if (valuesAt < 0) continue;
    const tuples = splitTuples(inner.slice(valuesAt + 6));
    if (!tuples.length || tuples.some((tuple) => splitTop(tuple.slice(1, -1), ",").length !== cols.length)) continue;
    const selects = tuples.map((tuple, index) => {
      const args = splitTop(tuple.slice(1, -1), ",").map((arg) => arg.trim());
      if (index === 0) return `select ${args.map((arg, col) => `${arg} as ${cols[col]}`).join(", ")}`;
      return `select ${args.join(", ")}`;
    });
    const start = open + 1 + valuesAt;
    out += sql.slice(cursor, start);
    out += `${selects.join(" union all ")}\n) as ${match[1]}`;
    cursor = match.index + match[0].length;
  }
  return out + sql.slice(cursor);
}

function rewriteNulls(sql: string): string {
  let next = sql.replace(
    /\b(case\b[\s\S]*?\bend)\s+(asc|desc)\s+nulls\s+last\b/gi,
    (_, expr: string, dir: string) => `(${expr}) is null, ${expr} ${dir}`,
  );
  next = next.replace(
    /([A-Za-z_][\w.]*)\s+(asc|desc)\s+nulls\s+last\b/gi,
    (_, expr: string, dir: string) => `(${expr}) is null, ${expr} ${dir}`,
  );
  return next;
}

function stripComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (inString) {
      out += char;
      if (char === "'" && next === "'") {
        out += next;
        i += 1;
        continue;
      }
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") {
      inString = true;
      out += char;
      continue;
    }
    if (char === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

/** Rewrite the app's Postgres SQL so MariaDB can run it. */
export function translateSql(sql: string): string {
  let next = splitStatements(stripComments(sql)).map(rewriteStatement).join(";");
  next = rewriteValues(next);
  next = next.replace(/^(\s*)("[A-Za-z0-9_]+"|[A-Za-z_][A-Za-z0-9_]*)\s+text\b/gm, (full, space: string, name: string) => {
    const bare = name.replaceAll('"', "");
    if (WIDE_TEXT.has(bare)) return full;
    return `${space}${name} varchar(191)`;
  });
  next = next.replace(/\bilike\b/gi, "LIKE");
  next = next.replace(/\bfor update of \w+/gi, "FOR UPDATE");
  next = next.replace(/extract\s*\(\s*epoch\s+from\s+([^)]+)\)/gi, "UNIX_TIMESTAMP($1)");
  next = next.replace(/\bserial\b/gi, "int not null auto_increment");
  next = next.replace(/\btimestamptz\b/gi, "datetime(6)");
  next = next.replace(/\bnumeric\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, "decimal($1,$2)");
  next = next.replace(/\bboolean\b/gi, "tinyint(1)");
  next = next.replace(/\binterval\s+'(\d+)\s+([a-z]+)'/gi, (_, amount: string, unit: string) => {
    return `INTERVAL ${amount} ${INTERVAL_UNIT[unit.toLowerCase()] || unit}`;
  });
  next = next.replace(
    /now\(\)\s*\+\s*\(\$(\d+)::int\s*\*\s*INTERVAL\s+1\s+HOUR\)/gi,
    "DATE_ADD(NOW(), INTERVAL $$$1 HOUR)",
  );
  next = next.replace(/\brandom\(\)/gi, "rand()");
  next = next.replace(
    /to_char\(\s*([A-Za-z_][\w.]*)\s+at\s+time\s+zone\s+'UTC'\s*,\s*'YYYY-MM-DD"T"HH24:MI:SS"Z"'\s*\)/gi,
    "CONCAT(DATE_FORMAT($1, '%Y-%m-%dT%H:%i:%s'), 'Z')",
  );
  next = rewriteNulls(next);
  next = replaceFilters(next);
  next = wrapCasts(next);
  return next;
}

export function bindParams(sql: string, params: unknown[] = []): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_, index: string) => {
    values.push(params[Number(index) - 1]);
    return "?";
  });
  return { text, values };
}

export function toMariaParams(sql: string, params: unknown[] = []): { text: string; values: unknown[] } {
  return bindParams(translateSql(sql), params);
}
