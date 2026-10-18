import { useRouter } from "next/router";
import { useState } from "react";

export default function UnsubscribePage() {
  const { query, isReady } = useRouter();
  const [state, setState] = useState<"ready" | "working" | "done" | "error">("ready");
  async function confirm() {
    if (typeof query.token !== "string") { setState("error"); return; }
    setState("working");
    try {
      const result = await fetch("/api/unsubscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: query.token }),
      });
      setState(result.ok ? "done" : "error");
    } catch { setState("error"); }
  }
  return <main style={{ maxWidth: 560, margin: "4rem auto", fontFamily: "system-ui", padding: "1rem" }}>
    <h1>Unsubscribe</h1>
    {state === "done" ? <p>You will no longer receive outreach from this system.</p> : <>
      <p>Stop future outreach to the address that received this email.</p>
      {state === "error" && <p>Link could not be verified. Contact the sender to opt out.</p>}
      <button type="button" disabled={!isReady || typeof query.token !== "string" || state === "working"}
        onClick={confirm}>{state === "working" ? "Processing…" : "Unsubscribe"}</button>
    </>}
  </main>;
}
