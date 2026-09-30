import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { getSimulatorDb, recordSimulatorMetric, getSimulatorScenario } from "./db.js";

export interface SimWebhookDelivery {
  id: string;
  subscription_id: string;
  target_url: string;
  secret: string;
  oem_id: string;
  event_id: string;
  payload: string;
  status: "PENDING" | "DELIVERED" | "EXHAUSTED" | "CANCELLED";
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export function enqueueWebhookDelivery(
  subscription: { id: string; oem_id: string; target_url: string; secret: string },
  eventId: string,
  payload: any,
  maxAttempts: number = 5
): string {
  const db = getSimulatorDb();
  const id = `whdel_${uuid().slice(0, 12)}`;
  const rawPayload = typeof payload === "string" ? payload : JSON.stringify(payload);
  const nowIso = new Date().toISOString();

  db.prepare(`
    INSERT INTO sim_webhook_deliveries (
      id, subscription_id, target_url, secret, oem_id, event_id, payload,
      status, attempts, max_attempts, next_retry_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)
  `).run(
    id,
    subscription.id,
    subscription.target_url,
    subscription.secret,
    subscription.oem_id,
    eventId,
    rawPayload,
    maxAttempts,
    nowIso,
    nowIso
  );

  recordSimulatorMetric("webhooks_enqueued");
  processPendingDeliveries().catch(() => {});
  return id;
}

export async function processPendingDeliveries(): Promise<number> {
  const outage = getSimulatorScenario("delivery_outage");
  if (outage.enabled) {
    return 0;
  }

  const db = getSimulatorDb();
  const nowIso = new Date().toISOString();
  const pending = db.prepare(`
    SELECT * FROM sim_webhook_deliveries
    WHERE status = 'PENDING' AND next_retry_at <= ?
    ORDER BY created_at ASC
    LIMIT 50
  `).all(nowIso) as SimWebhookDelivery[];

  let deliveredCount = 0;
  for (const item of pending) {
    const sub = db.prepare(
      "SELECT active FROM sim_subscriptions WHERE id = ?"
    ).get(item.subscription_id) as { active: number } | undefined;

    if (!sub || sub.active === 0) {
      db.prepare("UPDATE sim_webhook_deliveries SET status = 'CANCELLED' WHERE id = ?").run(item.id);
      continue;
    }

    const signature = crypto
      .createHmac("sha256", item.secret)
      .update(item.payload)
      .digest("hex");

    const duplicateScenario = getSimulatorScenario("duplicate_delivery");
    const sendCount = duplicateScenario.enabled ? 2 : 1;

    let success = false;
    let lastError: string | null = null;

    for (let i = 0; i < sendCount; i++) {
      try {
        const response = await fetch(item.target_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature-SHA256": signature,
            "X-OEM-ID": item.oem_id,
            "X-Event-ID": item.event_id,
            "X-Delivery-Attempt": String(item.attempts + 1),
          },
          body: item.payload,
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok || response.status === 202 || response.status === 200) {
          success = true;
        } else {
          lastError = `HTTP ${response.status}: ${response.statusText}`;
        }
      } catch (err: any) {
        lastError = err?.message || "Delivery network failure";
      }
    }

    const nextAttempts = item.attempts + 1;
    if (success) {
      db.prepare(`
        UPDATE sim_webhook_deliveries
        SET status = 'DELIVERED', attempts = ?, delivered_at = datetime('now'), last_error = NULL
        WHERE id = ?
      `).run(nextAttempts, item.id);
      recordSimulatorMetric("webhooks_delivered");
      recordSimulatorMetric("samples_delivered");
      deliveredCount++;
    } else {
      recordSimulatorMetric("webhook_errors");
      if (nextAttempts >= item.max_attempts) {
        db.prepare(`
          UPDATE sim_webhook_deliveries
          SET status = 'EXHAUSTED', attempts = ?, last_error = ?
          WHERE id = ?
        `).run(nextAttempts, lastError, item.id);
        recordSimulatorMetric("webhooks_exhausted");
      } else {
        const backoffSeconds = Math.min(60, Math.pow(2, nextAttempts));
        const retryAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        db.prepare(`
          UPDATE sim_webhook_deliveries
          SET status = 'PENDING', attempts = ?, next_retry_at = ?, last_error = ?
          WHERE id = ?
        `).run(nextAttempts, retryAt, lastError, item.id);
      }
    }
  }

  return deliveredCount;
}

export function getPendingDeliveries(): SimWebhookDelivery[] {
  const db = getSimulatorDb();
  return db.prepare("SELECT * FROM sim_webhook_deliveries WHERE status = 'PENDING' ORDER BY created_at ASC").all() as SimWebhookDelivery[];
}

export function getExhaustedDeliveries(): SimWebhookDelivery[] {
  const db = getSimulatorDb();
  return db.prepare("SELECT * FROM sim_webhook_deliveries WHERE status = 'EXHAUSTED' ORDER BY created_at DESC").all() as SimWebhookDelivery[];
}

export function retryExhaustedDeliveries(): number {
  const db = getSimulatorDb();
  const res = db.prepare(`
    UPDATE sim_webhook_deliveries
    SET status = 'PENDING', attempts = 0, next_retry_at = datetime('now')
    WHERE status = 'EXHAUSTED'
  `).run();
  processPendingDeliveries().catch(() => {});
  return res.changes;
}

export async function dispatchWebhook(
  subscription: { id: string; oem_id: string; target_url: string; secret: string },
  payload: any
): Promise<boolean> {
  const eventId = payload.event_id || payload.source_event_id || `evt_${Date.now()}`;
  enqueueWebhookDelivery(subscription, eventId, payload);
  return true;
}
