import { auth } from "@/lib/auth/server";
import { getSql } from "@/lib/db";
import { checkCodeForEmail, clientIp, issueCode, issueCodeForEmail } from "@/lib/verify.server";

const hits = new Map<string, number[]>();

function limit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((at) => now - at < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  hits.set(key, recent);
  return true;
}

function json(body: unknown, status = 200, cookies?: Headers) {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  for (const cookie of cookies?.getSetCookie?.() || []) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export async function registerAccount(request: Request): Promise<Response> {
  const ip = clientIp(request);
  if (!limit(`register:${ip}`, 8, 60 * 60_000)) {
    return json({ error: "Too many accounts were created from this network. Try again later." }, 429);
  }
  const body = (await request.json().catch(() => null)) as {
    name?: string;
    username?: string;
    email?: string;
    password?: string;
  } | null;
  const name = String(body?.name || "").trim();
  const username = String(body?.username || "").trim().toLowerCase();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (name.length < 2 || name.length > 80) return json({ error: "Enter your full name." }, 400);
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return json({ error: "Username must be 3–24 letters, numbers, or underscores." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
  if (password.length < 8 || password.length > 72) return json({ error: "Password must be 8–72 characters." }, 400);

  const sql = await getSql();
  const existingEmail = await sql.query(`select "id" from "user" where lower("email") = $1`, [email]);
  if (existingEmail.length) return json({ error: "An account with this email already exists." }, 409);
  const existingName = await sql.query(`select user_id from profiles where lower(username) = $1`, [username]);
  if (existingName.length) return json({ error: "That username is taken." }, 409);

  const signup = await auth.api.signUpEmail({
    body: { name, email, password },
    headers: request.headers,
    asResponse: true,
  });
  const payload = (await signup.json().catch(() => null)) as { user?: { id?: string }; message?: string } | null;
  if (!signup.ok || !payload?.user?.id) {
    return json({ error: payload?.message || "Could not create the account." }, signup.status || 400);
  }
  await sql.query(`update "user" set "emailVerified" = false, "updatedAt" = now() where "id" = $1`, [payload.user.id]);
  let sent = true;
  let error = "";
  try {
    await issueCode(payload.user.id, { ip });
  } catch (caught) {
    sent = false;
    error = caught instanceof Error ? caught.message : "We could not email the code. Use Resend code.";
  }
  return json({ ok: true, email, sent, error }, 200, signup.headers);
}

export async function verifyEmailCode(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string; code?: string } | null;
  const email = String(body?.email || "").trim().toLowerCase();
  const code = String(body?.code || "").replace(/\D/g, "");
  if (!email || !/^\d{6}$/.test(code)) return json({ error: "Enter the 6-digit code." }, 400);
  try {
    await checkCodeForEmail(email, code, clientIp(request));
    return json({ ok: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "That code is not correct.";
    const status = /too many requests/i.test(message) ? 429 : 400;
    return json({ error: message }, status);
  }
}

export async function resendEmailCode(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = String(body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
  try {
    const result = await issueCodeForEmail(email, clientIp(request));
    return json({ ok: true, email: result.email, sent: result.sent });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "We could not email the code. Use Resend code.";
    const status = /too many|wait 60/i.test(message) ? 429 : 502;
    return json({ error: message }, status);
  }
}
