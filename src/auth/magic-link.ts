import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { clientIp } from "../monitoring/spend-cap";
import { createSpendStoreFromEnv, type SpendStore } from "../monitoring/spend-store";

const JSON_HEADERS = { "Cache-Control": "no-store" } as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE = "nightcap_session";
const PKCE_COOKIE = "nightcap_pkce";
const SESSION_MAX_AGE = 60 * 60;
const PKCE_MAX_AGE = 10 * 60;
const MAGIC_LINKS_PER_IP_PER_HOUR = 5;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  user: z.object({ id: z.string().uuid() }).optional(),
});

const userResponseSchema = z.object({
  id: z.string().uuid(),
});

export interface MagicLinkAuth {
  startMagicLink(email: string, redirectTo: string, codeChallenge: string): Promise<boolean>;
  exchangeCode(code: string, verifier: string): Promise<string | null>;
  verifyTokenHash(tokenHash: string, type: string): Promise<string | null>;
  userIdForAccessToken(accessToken: string): Promise<string | null>;
}

function json(body: unknown, status: number, cookies: readonly string[] = []): Response {
  const headers = new Headers(JSON_HEADERS);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return Response.json(body, { status, headers });
}

function html(status: number, message: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(`<!doctype html><html lang="en"><body><p>${message}</p></body></html>`, { status, headers });
}

function cookieSuffix(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${cookieSuffix()}`;
}

function clearCookie(name: string): string {
  return `${name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${cookieSuffix()}`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function parseEmail(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const email = (body as { email?: unknown }).email;
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > 320 || !EMAIL.test(trimmed)) return null;
  return trimmed;
}

export function createPkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createMagicLinkHandler(
  auth: MagicLinkAuth | null,
  store: SpendStore,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!auth) return json({ error: "auth_unconfigured" }, 503);
    const raw = await request.text().catch(() => null);
    if (raw === null || raw.length > 2000) return json({ error: "invalid_request" }, 400);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const email = parseEmail(body);
    if (!email) return json({ error: "invalid_request" }, 400);
    let sent: number;
    try {
      sent = await store.recordPlan(`auth:${clientIp(request)}`, Date.now());
    } catch {
      return json({ error: "rate_limit_unavailable" }, 503);
    }
    if (sent > MAGIC_LINKS_PER_IP_PER_HOUR) return json({ error: "rate_limited" }, 429);
    const verifier = createPkceVerifier();
    const redirectTo = new URL("/auth/confirm", request.url).toString();
    const started = await auth.startMagicLink(email, redirectTo, pkceChallenge(verifier));
    if (!started) return json({ error: "auth_unavailable" }, 503);
    return json({ status: "sent" }, 200, [setCookie(PKCE_COOKIE, verifier, PKCE_MAX_AGE)]);
  };
}

function accessTokenFromVerify(payload: unknown): string | null {
  const parsed = tokenResponseSchema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data.access_token;
}

export function createConfirmHandler(auth: MagicLinkAuth | null): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!auth) return html(503, "Sign-in is not configured.");
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const tokenHash = url.searchParams.get("token_hash");
    const type = url.searchParams.get("type");
    let accessToken: string | null = null;
    if (code) {
      const verifier = readCookie(request, PKCE_COOKIE);
      if (!verifier) return html(400, "This sign-in link is not valid.", [clearCookie(PKCE_COOKIE)]);
      accessToken = await auth.exchangeCode(code, verifier);
    } else if (tokenHash && type) {
      accessToken = await auth.verifyTokenHash(tokenHash, type);
    }
    if (!accessToken) return html(400, "This sign-in link is not valid.", [clearCookie(PKCE_COOKIE)]);
    const headers = new Headers({
      location: new URL("/", request.url).toString(),
      "cache-control": "no-store",
    });
    headers.append("set-cookie", setCookie(SESSION_COOKIE, accessToken, SESSION_MAX_AGE));
    headers.append("set-cookie", clearCookie(PKCE_COOKIE));
    return new Response(null, { status: 303, headers });
  };
}

export async function userIdFromRequest(request: Request, auth: MagicLinkAuth): Promise<string | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return auth.userIdForAccessToken(token);
}

export function createSessionHandler(auth: MagicLinkAuth | null): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!auth) return json({ signedIn: false }, 200);
    const userId = await userIdFromRequest(request, auth);
    return json({ signedIn: userId !== null }, 200);
  };
}

function gotrueHeaders(anonKey: string, accessToken?: string): Headers {
  return new Headers({
    apikey: anonKey,
    authorization: `Bearer ${accessToken ?? anonKey}`,
    "content-type": "application/json",
  });
}

const GOTRUE_TIMEOUT_MS = 3000;

export function createGoTrueAuth(env: Record<string, string | undefined> = process.env): MagicLinkAuth | null {
  const base = env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const anonKey = env.SUPABASE_ANON_KEY?.trim() || env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!base || !anonKey) return null;
  const fetchImpl = fetch;

  return {
    async startMagicLink(email, redirectTo, codeChallenge) {
      const url = new URL(`${base}/auth/v1/otp`);
      url.searchParams.set("redirect_to", redirectTo);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: gotrueHeaders(anonKey),
        body: JSON.stringify({
          email,
          data: {},
          create_user: true,
          code_challenge: codeChallenge,
          code_challenge_method: "s256",
        }),
      }).catch(() => null);
      return response !== null && response.ok;
    },
    async exchangeCode(code, verifier) {
      const url = new URL(`${base}/auth/v1/token`);
      url.searchParams.set("grant_type", "pkce");
      const response = await fetchImpl(url, {
        method: "POST",
        headers: gotrueHeaders(anonKey),
        body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      }).catch(() => null);
      if (!response?.ok) return null;
      return accessTokenFromVerify(await response.json().catch(() => null));
    },
    async verifyTokenHash(tokenHash, type) {
      if (type !== "magiclink" && type !== "email") return null;
      const response = await fetchImpl(`${base}/auth/v1/verify`, {
        method: "POST",
        headers: gotrueHeaders(anonKey),
        body: JSON.stringify({ token_hash: tokenHash, type }),
      }).catch(() => null);
      if (!response?.ok) return null;
      return accessTokenFromVerify(await response.json().catch(() => null));
    },
    async userIdForAccessToken(accessToken) {
      const response = await fetchImpl(`${base}/auth/v1/user`, {
        method: "GET",
        headers: gotrueHeaders(anonKey, accessToken),
        signal: AbortSignal.timeout(GOTRUE_TIMEOUT_MS),
      }).catch(() => null);
      if (!response?.ok) return null;
      const parsed = userResponseSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? parsed.data.id : null;
    },
  };
}

export function createProductionMagicLinkHandler(): (request: Request) => Promise<Response> {
  return createMagicLinkHandler(createGoTrueAuth(), createSpendStoreFromEnv());
}

export function createProductionConfirmHandler(): (request: Request) => Promise<Response> {
  return createConfirmHandler(createGoTrueAuth());
}

export function createProductionSessionHandler(): (request: Request) => Promise<Response> {
  return createSessionHandler(createGoTrueAuth());
}
