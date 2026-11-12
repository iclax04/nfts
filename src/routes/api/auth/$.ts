import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";
import { registerAccount, resendEmailCode, verifyEmailCode } from "@/lib/auth/register.server";

function pathOf(request: Request) {
  return new URL(request.url).pathname.replace(/\/$/, "");
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => {
        const path = pathOf(request);
        if (path.endsWith("/api/auth/register")) return registerAccount(request);
        if (path.endsWith("/api/auth/verify-email")) return verifyEmailCode(request);
        if (path.endsWith("/api/auth/resend-code")) return resendEmailCode(request);
        return auth.handler(request);
      },
    },
  },
});
