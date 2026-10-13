"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

export function SaveShare({ itineraryId }: { readonly itineraryId?: string }) {
  const [email, setEmail] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [note, setNote] = useState("");
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/session", { signal: controller.signal })
      .then((response) => response.json())
      .then((body: { signedIn?: boolean }) => {
        if (!controller.signal.aborted) setSignedIn(body.signedIn === true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSignedIn(false);
      });
    return () => controller.abort();
  }, []);

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setNote(response.ok ? "Check your email for a sign-in link." : "The sign-in link could not be sent.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!itineraryId) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/saved-plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itineraryId }),
      });
      if (response.status === 401) {
        setSignedIn(false);
        setNote("Sign in to save this plan.");
        return;
      }
      if (!response.ok) {
        setNote("This plan could not be saved.");
        return;
      }
      const body = (await response.json()) as { sharePath?: string };
      if (typeof body.sharePath === "string") {
        setSharePath(body.sharePath);
        setNote("Saved.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!sharePath) return;
    const url = `${window.location.origin}${sharePath}`;
    try {
      await navigator.clipboard.writeText(url);
      setNote("Link copied.");
    } catch {
      setNote(url);
    }
  }

  return (
    <section className="save-share">
      <h2>Save and share</h2>
      {signedIn ? (
        <p>Signed in.</p>
      ) : (
        <form onSubmit={(event) => void sendLink(event)}>
          <label>
            Email for a sign-in link
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || email.trim().length === 0}>
            Email me a link
          </button>
        </form>
      )}
      <button type="button" disabled={busy || !signedIn || !itineraryId} onClick={() => void save()}>
        Save this plan
      </button>
      {sharePath ? (
        <p>
          <Link href={sharePath}>{sharePath}</Link>
          <button type="button" onClick={() => void copyLink()}>
            Copy link
          </button>
        </p>
      ) : null}
      {note ? (
        <p className="notice" role="status">
          {note}
        </p>
      ) : null}
    </section>
  );
}
