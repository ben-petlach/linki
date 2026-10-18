import Head from "next/head";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { HeldAction } from "@/lib/reliability/operations";

interface OperationView {
  dispatch: { paused: boolean; reason: string; updatedBy: string | null; updatedAt: string | null };
  heldActions: HeldAction[];
  alerts: Array<{ fingerprint: string; kind: string; subject_id: string; message: string; first_seen_at: string }>;
  metrics: Record<string, number>;
}

export default function OperationsPage() {
  const [view, setView] = useState<OperationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState("");
  const [decision, setDecision] = useState<"note" | "confirm_provider_accepted">("note");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/operations");
      if (!response.ok) throw new Error(`Operations request failed (${response.status})`);
      setView(await response.json() as OperationView);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load operations");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  async function changePause(paused: boolean) {
    if (!reason.trim()) { toast.error("Reason required"); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/operations/pause", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused, reason }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Pause change failed");
      setReason("");
      await refresh();
      toast.success(paused ? "Outbound dispatch paused; inbox polling continues" : "Outbound dispatch resumed");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Pause change failed"); }
    finally { setBusy(false); }
  }

  async function submitReview(actionKey: string) {
    if (!reviewReason.trim() || !reviewEvidence.trim()) { toast.error("Reason and evidence required"); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/operations/actions/${encodeURIComponent(actionKey)}/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: reviewReason, evidence: reviewEvidence }),
      });
      const data = await response.json() as { error?: string; reason?: string };
      if (!response.ok) throw new Error(data.error ?? "Review failed");
      setSelected(null); setReviewReason(""); setReviewEvidence(""); setDecision("note");
      await refresh();
      toast.success(data.reason ?? "Review recorded");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Review failed"); }
    finally { setBusy(false); }
  }

  return <>
    <Head><title>Operations | Linki</title></Head>
    <main className="mx-auto max-w-6xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Operations</h1>
        <p className="text-sm opacity-70">Durable sends, inbox health, and recovery decisions.</p>
      </header>
      {loading && <p>Loading operations…</p>}
      {view && <>
        <section className="rounded-xl border border-base-300 p-5 space-y-3">
          <h2 className="font-semibold">Global outbound dispatch</h2>
          <p className={view.dispatch.paused ? "text-warning" : "text-success"}>
            {view.dispatch.paused ? `Paused: ${view.dispatch.reason}` : "Running"}
          </p>
          <p className="text-xs opacity-70">Pause blocks new prospect sends. Inbox monitoring continues. Sends already accepted by a provider remain recorded.</p>
          <div className="flex gap-2 items-center">
            <input className="input input-bordered flex-1" aria-label="Pause change reason" placeholder="Reason for this decision" value={reason}
              onChange={event => setReason(event.target.value)} maxLength={2000} />
            <button className="btn btn-primary" disabled={busy || !reason.trim()}
              onClick={() => void changePause(!view.dispatch.paused)}>
              {view.dispatch.paused ? "Resume dispatch" : "Pause dispatch"}
            </button>
          </div>
        </section>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(view.metrics).map(([key, count]) => <div key={key} className="rounded-xl border border-base-300 p-4">
            <div className="text-xs opacity-70">{key.replace(/([A-Z])/g, " $1").toLowerCase()}</div>
            <div className="text-xl font-semibold">{count}</div>
          </div>)}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Open alerts ({view.alerts.length})</h2>
          {!view.alerts.length && <p className="text-sm opacity-70">No open alerts.</p>}
          {view.alerts.map(alert => <div key={alert.fingerprint} className="rounded-xl border border-warning/40 p-3 text-sm">
            <span className="font-medium">{alert.kind}</span>: {alert.message} <span className="opacity-60">({alert.subject_id})</span>
          </div>)}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Held actions ({view.heldActions.length})</h2>
          {!view.heldActions.length && <p className="text-sm opacity-70">No uncertain sends.</p>}
          {view.heldActions.map(action => <article key={action.action_key} className="rounded-xl border border-base-300 p-4 space-y-2">
            <div className="flex flex-wrap justify-between gap-2">
              <div><strong>{action.target_name ?? action.target_id}</strong> · {action.recipient ?? "Recipient unavailable"}</div>
              <span className="text-warning">{action.state}</span>
            </div>
            <div className="text-sm opacity-75">Sender: {action.sender_name ?? action.sender_id} · Channel: {action.channel} · Action: {action.action_key}</div>
            <div className="text-sm">Reason: {action.reason ?? "Provider outcome not confirmed"}</div>
            {action.payload && <details className="text-sm"><summary className="cursor-pointer">Prepared payload</summary><pre className="whitespace-pre-wrap break-all p-2 bg-base-200 rounded">{action.payload}</pre></details>}
            {action.evidence && <p className="text-sm break-all">Evidence: {action.evidence}</p>}
            {action.provider_accepted_at && <p className="text-sm text-success break-all">SMTP accepted at {action.provider_accepted_at}; message ID {action.provider_message_id}</p>}
            <button className="btn btn-sm btn-outline" onClick={() => { setSelected(selected === action.action_key ? null : action.action_key); setDecision("note"); }}>Review</button>
            {selected === action.action_key && <div className="space-y-2 border-t border-base-300 pt-3">
              <select className="select select-bordered w-full" aria-label="Review decision" value={decision}
                onChange={event => setDecision(event.target.value as typeof decision)}>
                <option value="note">Record evidence; keep held</option>
                {action.channel === "email" && action.provider_accepted_at && <option value="confirm_provider_accepted">Confirm persisted SMTP acceptance</option>}
              </select>
              <input className="input input-bordered w-full" aria-label="Review reason" placeholder="Why this decision?" value={reviewReason}
                onChange={event => setReviewReason(event.target.value)} maxLength={2000} />
              <textarea className="textarea textarea-bordered w-full" aria-label="Review evidence" placeholder="Evidence inspected (provider ID, timestamp, source)" value={reviewEvidence}
                onChange={event => setReviewEvidence(event.target.value)} maxLength={4000} />
              <button className="btn btn-primary btn-sm" disabled={busy || !reviewReason.trim() || !reviewEvidence.trim()}
                onClick={() => void submitReview(action.action_key)}>Save review</button>
            </div>}
          </article>)}
        </section>
      </>}
    </main>
  </>;
}
