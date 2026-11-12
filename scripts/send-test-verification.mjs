import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/send-test-verification.mjs you@example.com");
  process.exit(1);
}

const env = {};
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[trimmed.slice(0, index).trim()] = value;
  }
} catch {
  console.error("Could not read .env");
  process.exit(1);
}

const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
const port = Number(env.SMTP_PORT || 587);
const from = env.SMTP_FROM || "Agora Gallery NFTs <no-reply@agora-gallery.io>";
const text = `Your Agora Gallery NFTs verification code is ${code}. This code expires in 10 minutes. If you didn't create this account, you can ignore this email.`;
const html = `<body style="margin:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;padding:32px"><p style="font-size:20px;font-weight:700">Agora Gallery NFTs</p><h1>Verify your email</h1><p style="font-size:40px;letter-spacing:8px;font-weight:700">${code}</p><p>This code expires in 10 minutes. If you didn't create this account, you can ignore this email.</p></body>`;

const tx = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port,
  secure: port === 465,
  requireTLS: port === 587,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
});

const info = await tx.sendMail({ from, to, subject: "Your Agora Gallery NFTs verification code", text, html });
console.log(`Sent test message to ${to}`);
console.log(info.response);
