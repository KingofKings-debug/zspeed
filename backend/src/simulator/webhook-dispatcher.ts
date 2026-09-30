import crypto from "crypto";
import { recordSimulatorMetric, getSimulatorScenario } from "./db.js";

export async function dispatchWebhook(
  subscription: { id: string; oem_id: string; target_url: string; secret: string },
  payload: any
): Promise<boolean> {
  const outage = getSimulatorScenario("delivery_outage");
  if (outage.enabled) {
    return false;
  }

  const rawBody = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", subscription.secret)
    .update(rawBody)
    .digest("hex");

  const duplicateScenario = getSimulatorScenario("duplicate_delivery");
  const sendCount = duplicateScenario.enabled ? 2 : 1;

  let success = false;
  for (let i = 0; i < sendCount; i++) {
    try {
      const response = await fetch(subscription.target_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-SHA256": signature,
          "X-OEM-ID": subscription.oem_id,
          "X-Event-ID": payload.event_id || payload.source_event_id || `evt_${Date.now()}`,
          "X-Delivery-Attempt": String(i + 1),
        },
        body: rawBody,
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok || response.status === 202) {
        recordSimulatorMetric("webhooks_delivered");
        recordSimulatorMetric("samples_delivered");
        success = true;
      } else {
        recordSimulatorMetric("webhook_errors");
      }
    } catch {
      recordSimulatorMetric("webhook_errors");
    }
  }

  return success;
}
