import { useEffect, useState } from "react";
import "./ApprovalPage.css";

const PREPAY_URL = "/api/square/booking-requests/prepay";

function dollars(cents) {
  return Number.isInteger(cents) ? `$${(cents / 100).toFixed(0)}` : "";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export default function PaymentPage({ complete = false }) {
  const [requestKey] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("requestKey") || "";
  });
  const [phase, setPhase] = useState("checking");
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!requestKey) {
        setPhase("done");
        setError("This payment link is invalid.");
        return;
      }
      try {
        const res = await fetch(`${PREPAY_URL}?requestKey=${encodeURIComponent(requestKey)}`);
        const data = await readJson(res);
        if (cancelled) return;
        if (!res.ok) throw new Error(data?.error || "Payment is not available for this appointment.");
        setPayment(data);
        setPhase("done");
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || "Could not check payment right now.");
          setPhase("done");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [requestKey]);

  async function createPaymentLink() {
    setPhase("working");
    setError(null);
    try {
      const res = await fetch(PREPAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestKey }),
      });
      const data = await readJson(res);
      if (!res.ok || !data) throw new Error(data?.error || "Could not create payment link.");
      setPayment(data);
      setPhase("done");
      if (data.paymentLinkUrl && typeof window !== "undefined") {
        window.location.assign(data.paymentLinkUrl);
      }
    } catch (err) {
      setError(err?.message || "Could not create payment link.");
      setPhase("done");
    }
  }

  const paid = payment?.paid === true || payment?.paymentStatus === "paid";

  return (
    <div className="ap-page">
      <div className="ap-card">
        <header className="ap-header">
          <p className="ap-eyebrow">Kai Lani Bodywork &amp; Wellness</p>
          <h1 className="ap-title">{complete ? "Payment status" : "Appointment payment"}</h1>
        </header>

        {(phase === "checking" || phase === "working") && (
          <p className="ap-status" role="status">
            {phase === "working" ? "Opening Square checkout..." : "Checking your payment..."}
          </p>
        )}

        {phase === "done" && error && <p className="ap-message ap-message-error" role="alert">{error}</p>}

        {phase === "done" && !error && payment && (
          <div className="ap-result">
            {paid ? (
              <>
                <h2 className="ap-result-title">Payment received ✓</h2>
                <p className="ap-result-message">You're all set. We look forward to seeing you.</p>
              </>
            ) : complete ? (
              <>
                <h2 className="ap-result-title">Your payment was submitted through Square.</h2>
                <p className="ap-result-message">We're confirming the payment status now.</p>
              </>
            ) : (
              <>
                <p className="ap-eyebrow">Payment</p>
                <h2 className="ap-result-title">{dollars(payment.amount)}</h2>
                <p className="ap-result-message">Prefer to take care of payment ahead of time?</p>
                <p className="ap-result-message">You can securely prepay through Square, or simply pay at your appointment.</p>
                <button type="button" className="ap-btn ap-btn-primary" onClick={createPaymentLink}>
                  Pay now securely with Square
                </button>
                <p className="ap-result-message ap-payment-footnote">Or pay at your appointment.</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
