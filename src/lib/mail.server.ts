import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";

function loadMailEnv() {
  try {
    const text = readFileSync("/workspace/.env", "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key.startsWith("SMTP_") && !key.startsWith("MAIL_") && key !== "RESEND_API_KEY" && key !== "SENDGRID_API_KEY") continue;
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) process.env[key] = value;
    }
  } catch {
    /* No local mail file. Hosting can set SMTP_* in the environment instead. */
  }
}

function mailSettings() {
  loadMailEnv();
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    from: process.env.SMTP_FROM?.trim() || "Agora Gallery NFTs <no-reply@agora-gallery.io>",
    host: process.env.SMTP_HOST?.trim() || "smtppro.zoho.com",
    port,
    user: process.env.SMTP_USER?.trim() || "no-reply@agora-gallery.io",
    pass: process.env.SMTP_PASS?.trim() || "China246@#",
  };
}

export function smtpConfigured(): boolean {
  const mail = mailSettings();
  return Boolean(mail.host && mail.user && mail.pass);
}

function transport() {
  const mail = mailSettings();
  return nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.port === 465,
    requireTLS: mail.port === 587,
    auth: { user: mail.user, pass: mail.pass },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 10_000,
  });
}

export async function sendVerificationEmail(accountEmail: string, code: string): Promise<boolean> {
  const mail = mailSettings();
  const inbox = accountEmail.trim().toLowerCase();
  const text = `Your Agora Gallery NFTs verification code is ${code}. This code expires in 10 minutes. If you didn't create this account, you can ignore this email.`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
          <tr><td>
            <p style="margin:0;font-size:20px;font-weight:700;">Agora Gallery NFTs</p>
            <h1 style="margin:24px 0 8px;font-size:24px;">Verify your email</h1>
            <p style="margin:0 0 24px;font-size:15px;line-height:1.5;">Enter this code to finish creating your account.</p>
            <p style="margin:0 0 24px;font-size:40px;letter-spacing:8px;font-weight:700;">${code}</p>
            <p style="margin:0;font-size:13px;color:#6b7280;">This code expires in 10 minutes. If you didn't create this account, you can ignore this email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return deliver(inbox, "Your Agora Gallery NFTs verification code", text, html, mail.from);
}

async function deliver(to: string, subject: string, text: string, html: string, from: string): Promise<boolean> {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const sendgridKey = process.env.SENDGRID_API_KEY?.trim();
  const provider = resendKey ? "resend" : sendgridKey ? "sendgrid" : "";
  try {
    if (resendKey) await sendResend(to, subject, text, html, from);
    else if (sendgridKey) await sendSendgrid(to, subject, text, html, from);
    else {
      console.error("[mail] not sent: RESEND_API_KEY is not set");
      return false;
    }
    console.info(`[mail] sent to ${to} via ${provider}`);
    return true;
  } catch (error) {
    const last = error instanceof Error ? error.message : "Email send failed.";
    console.error(`[mail] failed to ${to} via ${provider}: ${last}`);
    return false;
  }
}

async function sendResend(to: string, subject: string, text: string, html: string, from: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text, html }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend returned ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
}

async function sendSendgrid(to: string, subject: string, text: string, html: string, from: string) {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from.match(/<([^>]+)>/)?.[1] || from, name: "Agora Gallery NFTs" },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
  });
  if (!response.ok) throw new Error(`SendGrid returned ${response.status}`);
}

export async function sendAccountNotice(to: string, subject: string, text: string): Promise<boolean> {
  if (smtpConfigured()) {
    return deliver(to, subject, text, `<p>${text}</p>`, mailSettings().from);
  }
  const response = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(to)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name: "Agora Gallery NFTs", email: "no-reply@agora-gallery.io", message: text, _subject: subject, _captcha: "false", _replyto: "no-reply@agora-gallery.io" }),
  });
  return response.ok;
}
