import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { errMsg } from "@/lib/format";
import { updateMe } from "@/lib/market.functions";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { RedirectToSignIn } from "@/lib/auth/gates";

export const Route = createFileRoute("/verify-email")({
  validateSearch: (search: Record<string, unknown>) => ({
    email: typeof search.email === "string" ? search.email : "",
    sent: search.sent === "0" ? "0" : search.sent === "1" ? "1" : "",
  }),
  component: VerifyPage,
});

const codeSends = new Map<string, Promise<void>>();

function afterSignIn() {
  const next = sessionStorage.getItem("agora-next");
  sessionStorage.removeItem("agora-next");
  if (next && next.startsWith("/art/")) return next;
  return "/dashboard";
}

function VerifyPage() {
  const { email, sent } = Route.useSearch();
  const { user, isPending } = useCurrentUserState();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(sent === "1" ? 60 : 0);
  const [sending, setSending] = useState(sent !== "1");
  const [backup, setBackup] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const raw = window.sessionStorage.getItem("agora-signup-profile");
    if (!raw) return;
    window.sessionStorage.removeItem("agora-signup-profile");
    try {
      const saved = JSON.parse(raw) as { username?: string; displayName?: string };
      if (!saved.username || !saved.displayName) return;
      void updateMe({
        data: {
          displayName: saved.displayName,
          username: saved.username,
          bio: "",
          city: "",
          phone: "",
          region: "",
          postalCode: "",
          siteUrl: "",
          xHandle: "",
          avatar: "",
          clearAvatar: false,
          wallet: "",
        },
      }).catch(() => undefined);
    } catch {
      /* ignore a bad saved profile */
    }
  }, [user]);

  useEffect(() => {
    const address = email;
    if (sent === "1") {
      setError(null);
      setNote(`We sent a 6-digit code to ${address}. Check that inbox and the spam folder. It expires in 10 minutes.`);
      setSending(false);
      return;
    }
    if (sent === "0") {
      const saved = window.sessionStorage.getItem("agora-verify-code");
      if (saved) {
        setBackup(saved);
        setCode(saved);
      }
      setNote(saved ? "Email could not be sent. Enter the code shown here. It expires in 10 minutes." : null);
      setError(saved ? null : window.sessionStorage.getItem("agora-mail-error") || "We could not email the code.");
      setSending(false);
      return;
    }
    if (!address) return;
    let live = true;
    const existing = codeSends.get(address);
    const job = existing || fetch("/api/auth/resend-code", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: address }),
    }).then(async (response) => {
      const data = (await response.json().catch(() => null)) as { error?: string; email?: string } | null;
      if (!response.ok) throw new Error(data?.error || "We could not email the code. Use Resend code.");
      return data?.email || address;
    });
    if (!existing) codeSends.set(address, job.then(() => undefined));
    void job
      .then((inbox) => {
        if (!live) return;
        setError(null);
        setWait(60);
        setNote(`We sent a 6-digit code to ${inbox}. Check that inbox and the spam folder. It expires in 10 minutes.`);
      })
      .catch((caught) => {
        if (!live) return;
        setNote(null);
        setError(errMsg(caught));
      })
      .finally(() => {
        if (live) setSending(false);
      });
    return () => {
      live = false;
    };
  }, [email, sent]);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setInterval(() => setWait((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [wait]);

  if (isPending) return <p className="px-4 py-16 text-muted">Checking your session…</p>;
  if (!user) return <RedirectToSignIn />;

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/resend-code", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        email?: string;
        code?: string;
        sent?: boolean;
      } | null;
      if (!response.ok) throw new Error(data?.error || "We could not email the code.");
      if (data?.sent === false && data.code) {
        setBackup(data.code);
        setCode(data.code);
        window.sessionStorage.setItem("agora-verify-code", data.code);
        setNote("Email could not be sent. Enter the code shown here.");
        return;
      }
      setBackup(null);
      setWait(60);
      setNote(`A new code was sent to ${data?.email || email}. Check that inbox and the spam folder.`);
    } catch (caught) {
      setError(errMsg(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/verify-email", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error || "That code is not correct.");
      await router.invalidate();
      window.location.replace(afterSignIn());
    } catch (caught) {
      setError(errMsg(caught));
      setBusy(false);
    }
  }

  async function useDifferentEmail() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    window.location.assign("/create-account");
  }

  return (
    <div className="mx-auto grid min-h-[70vh] max-w-md place-items-center px-4 py-12">
      <div className="w-full">
        <p className="kicker">Agora Gallery NFTs</p>
        <h1 className="mt-2 text-4xl">Verify your email</h1>
        <p className="mt-2 text-sm text-muted">
          {email ? `Enter the 6-digit code sent to ${email}.` : "Enter the 6-digit code from your email."}
        </p>
          {backup ? (
            <p className="mt-6 text-sm">
              Your verification code is <span className="font-semibold tracking-[0.3em]">{backup}</span>
            </p>
          ) : null}
          {sending ? <p className="mt-6 text-sm text-muted">Sending your code…</p> : null}
        <form onSubmit={onSubmit} className="mt-8 space-y-3">
          <label className="block">
            <span className="label">Verification code</span>
            <input
              className="field text-center text-2xl tracking-[0.4em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              required
            />
          </label>
          {note ? <p className="text-sm text-muted">{note}</p> : null}
          {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
          <button className="btn w-full" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Checking…" : "Verify email"}
          </button>
        </form>
        <button type="button" className="mt-4 text-sm font-semibold text-accent disabled:opacity-50" disabled={busy || wait > 0} onClick={() => void resend()}>
          {wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
        </button>
        <button type="button" className="mt-3 block text-sm text-muted" onClick={() => void useDifferentEmail()}>
          Use a different email
        </button>
      </div>
    </div>
  );
}
