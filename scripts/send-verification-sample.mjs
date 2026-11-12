import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/send-verification-sample.mjs you@example.com");
  process.exit(1);
}

try {
  const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value && !process.env[key]) process.env[key] = value;
  }
} catch {
  /* Hosting can provide the variables without a local file. */
}

const code = "000000";
const from = process.env.SMTP_FROM || "Agora Gallery NFTs <no-reply@agora-gallery.io>";
const html = `<!doctype html><body style="margin:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;padding:32px 16px;"><tr><td align="center"><table style="max-width:480px"><tr><td><p style="margin:0;font-size:20px;font-weight:700;">Agora Gallery NFTs</p><h1 style="margin:24px 0 8px;font-size:24px;">Verify your email</h1><p style="margin:0 0 24px;font-size:15px;line-height:1.5;">Enter this code to finish creating your account.</p><p style="margin:0 0 24px;font-size:40px;letter-spacing:8px;font-weight:700;">${code}</p><p style="margin:0;font-size:13px;color:#6b7280;">This code expires in 10 minutes. If you didn't create this account, you can ignore this email.</p></td></tr></table></td></tr></table></body>`;
const textBody = `Your Agora Gallery NFTs verification code is ${code}. This code expires in 10 minutes. If you didn't create this account, you can ignore this email. This is a delivery test, not a sign-in code.`;
const port = Number(process.env.SMTP_PORT || 587);
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: port === 465,
  requireTLS: port === 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
const info = await transport.sendMail({
  from,
  to,
  subject: "Your Agora Gallery NFTs verification code",
  text: textBody,
  html,
});
console.log(info.response);
