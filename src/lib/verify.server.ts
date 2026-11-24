import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { sendVerificationEmail } from "@/lib/mail.server";

function mailWithin(send: Promise<boolean>): Promise<boolean> {
  return Promise.race([
    send,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 7000)),
  ]);
}

function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function matches(code: string, salt: string, expected: string): boolean {
  const actual = hashCode(code, salt);
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const pendingCodes = new Map<string, { code: string; at: number; sent: boolean }>();
const hits = new Map<string, number[]>();

function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((at) => now - at < windowMs);
  if (recent.length >= max) throw new Error("Too many requests. Wait a few minutes and try again.");
  recent.push(now);
  hits.set(key, recent);
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "local";
}

function rememberedCode(userId: string): { code: string; at: number; sent: boolean } | null {
  const pending = pendingCodes.get(userId);
  if (!pending || Date.now() - pending.at > 10 * 60_000) return null;
  return pending;
}

export async function emailFor(userId: string): Promise<{ email: string; verified: boolean }> {
  const sql = await getSql();
  const rows = await sql.query<{ email: string; verified: boolean }>(
    `select "email", "emailVerified" as verified from "user" where "id" = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row?.email) throw new Error("Account not found.");
  return { email: row.email.toLowerCase(), verified: Boolean(row.verified) };
}

async function userIdForEmail(email: string): Promise<string> {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(`select "id" from "user" where lower("email") = $1`, [email]);
  if (!rows[0]) throw new Error("Account not found.");
  return rows[0].id;
}

export async function issueCode(userId: string, opts?: { ip?: string; bypassLimit?: boolean }) {
  const sql = await getSql();
  const { email, verified } = await emailFor(userId);
  if (verified) return { ok: true, already: true, sent: true, email };
  const ip = opts?.ip || "local";
  if (!opts?.bypassLimit) {
    rateLimit(`resend-email:${email}`, 5, 60 * 60_000);
    rateLimit(`resend-ip:${ip}`, 20, 60 * 60_000);
  }
  const recent = await sql.query<{ created_at: Date | string }>(
    `select created_at from email_verifications where user_id = $1 order by created_at desc limit 1`,
    [userId],
  );
  if (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 60_000) {
    const pending = rememberedCode(userId);
    if (pending?.sent) return { ok: true, already: false, sent: true, email };
    if (pending) {
  const sent = await mailWithin(sendVerificationEmail(email, pending.code));
      pending.sent = sent;
      if (!sent) throw new Error("We could not email the code. Use Resend code.");
      return { ok: true, already: false, sent: true, email };
    }
  }
  if (!opts?.bypassLimit) {
    const hourly = await sql.query<{ n: number }>(
      `select count(*)::int as n from email_verifications where user_id = $1 and created_at > now() - interval '1 hour'`,
      [userId],
    );
    if (Number(hourly[0]?.n || 0) >= 5) throw new Error("Too many codes were sent. Try again in an hour.");
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  pendingCodes.set(userId, { code, at: Date.now(), sent: false });
  await sql.query(`update email_verifications set used_at = now() where user_id = $1 and used_at is null`, [userId]);
  await sql.query(
    `insert into email_verifications (user_id, code_hash, salt, expires_at) values ($1, $2, $3, now() + interval '10 minutes')`,
    [userId, hashCode(code, salt), salt],
  );
  const sent = await mailWithin(sendVerificationEmail(email, code));
  const pending = pendingCodes.get(userId);
  if (pending) pending.sent = sent;
  if (!sent) {
    await sql.query(`update email_verifications set used_at = now() where user_id = $1 and used_at is null`, [userId]);
    pendingCodes.delete(userId);
    throw new Error("We could not email the code. Use Resend code.");
  }
  return { ok: true, already: false, sent: true, email };
}

export async function issueCodeForEmail(email: string, ip?: string) {
  const userId = await userIdForEmail(email.trim().toLowerCase());
  return issueCode(userId, { ip });
}

export async function checkCode(userId: string, code: string, ip?: string) {
  const sql = await getSql();
  const { email } = await emailFor(userId);
  rateLimit(`verify-email:${email}`, 10, 10 * 60_000);
  rateLimit(`verify-ip:${ip || "local"}`, 20, 10 * 60_000);
  const rows = await sql.query<{
    id: number;
    code_hash: string;
    salt: string;
    attempts: number;
    used_at: Date | string | null;
    expired: boolean;
  }>(
    `select id, code_hash, salt, attempts, used_at, (expires_at < now()) as expired
     from email_verifications where user_id = $1 order by created_at desc limit 1`,
    [userId],
  );
  const row = rows[0];
  if (!row || row.used_at) throw new Error("Request a new code.");
  if (Number(row.attempts) >= 5) throw new Error("Too many attempts. Request a new code.");
  if (row.expired) throw new Error("This code has expired. Request a new code.");
  if (!matches(code, row.salt, row.code_hash)) {
    const attempts = Number(row.attempts) + 1;
    await sql.query(`update email_verifications set attempts = $2 where id = $1`, [row.id, attempts]);
    if (attempts >= 5) throw new Error("Too many attempts. Request a new code.");
    throw new Error(`That code is not correct. ${5 - attempts} attempts left.`);
  }
  await sql.query(`update email_verifications set used_at = now() where id = $1`, [row.id]);
  await sql.query(`update "user" set "emailVerified" = true, "updatedAt" = now() where "id" = $1`, [userId]);
  pendingCodes.delete(userId);
  return { ok: true, email };
}

export async function checkCodeForEmail(email: string, code: string, ip?: string) {
  const userId = await userIdForEmail(email.trim().toLowerCase());
  return checkCode(userId, code, ip);
}
