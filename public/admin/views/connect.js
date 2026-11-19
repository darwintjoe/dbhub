import { el, card, actionButton, copyButton, toast } from "../lib/dom.js";
import { pageTitle, kv } from "./common.js";

function demoQr() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" role="img" aria-label="Simulated pairing code graphic">',
    '<rect width="21" height="21" fill="#fff"/>',
  ];
  for (let y = 0; y < 21; y++) {
    for (let x = 0; x < 21; x++) {
      const on = ((x * 7 + y * 11 + ((x ^ y) & 3)) % 5) < 2;
      const corner = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      if (on || corner) svg.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="#111"/>`);
    }
  }
  svg.push('<text x="10.5" y="12.4" font-family="sans-serif" font-size="4" text-anchor="middle" fill="#c62828">DEMO</text></svg>');
  try {
    const doc = new DOMParser().parseFromString(svg.join(""), "image/svg+xml");
    return document.importNode(doc.documentElement, true);
  } catch (e) {
    return el("div", { class: "empty", text: "Simulated pairing code" });
  }
}

export function mountConnect(main, ctx) {
  const { api } = ctx;

  main.appendChild(pageTitle("Pair a device", "Create a pairing, then approve it on this hub"));

  const live = el("div", { class: "muted", "aria-live": "polite" });
  main.appendChild(live);

  const formCard = card({ title: "New pairing", subtitle: "Tokens are shown once on the device" });
  const labelField = el("div", { class: "field" }, [
    el("label", { text: "Label" }), el("input", { id: "pair-label", type: "text", value: "Device" }),
  ]);
  const networkField = el("div", { class: "field" }, [
    el("label", { text: "Network" }),
    el("select", { id: "pair-network" }, [
      el("option", { value: "lan", text: "LAN" }),
      el("option", { value: "wan", text: "WAN" }),
    ]),
  ]);
  const approvalField = el("div", { class: "field" }, [
    el("label", { text: "Approval" }),
    el("input", { id: "pair-approval", type: "checkbox", checked: true }),
  ]);
  approvalField.querySelector("label").textContent = "Require approval (recommended for WAN)";
  const createBtn = actionButton("Create pairing", createPairing, { primary: true });
  formCard.querySelector(".card-body").append(
    el("div", { class: "two-col" }, [labelField, networkField]),
    approvalField,
    el("div", { class: "row" }, [createBtn]),
  );
  main.appendChild(formCard);

  const stateCard = card({ title: "Pairing status", subtitle: "Waiting for the device to claim" });
  const stateDiv = el("div", { class: "stack" });
  stateCard.querySelector(".card-body").appendChild(stateDiv);
  main.appendChild(stateCard);

  main.appendChild(el("p", { class: "muted", text: "Manual fallback: enter the pairing code on the device if the camera cannot scan the QR." }));

  let currentId = null;
  let pollTimer = null;
  let countdownTimer = null;

  async function createPairing() {
    const label = labelField.querySelector("input").value.trim() || "Device";
    const network = networkField.querySelector("select").value;
    const requireApproval = approvalField.querySelector("input").checked;
    try {
      const data = await api("/api/v1/admin/pairings", {
        method: "POST",
        body: JSON.stringify({ label, network, requireApproval, role: "device" }),
      });
      currentId = data.pairingId;
      live.textContent = "Pairing created";
      renderWaiting(data);
      startPolling();
    } catch (e) { live.textContent = e.message; }
  }

  function renderWaiting(data) {
    stateDiv.replaceChildren();
    const qrWrap = el("div", {});
    if (ctx.isDemo) {
      qrWrap.appendChild(demoQr());
    } else {
      const img = el("img", { class: "qr-img", alt: "Pairing QR code", src: `/api/v1/admin/pairings/${encodeURIComponent(currentId)}/qr.svg` });
      qrWrap.appendChild(img);
    }
    stateDiv.appendChild(qrWrap);
    stateDiv.appendChild(el("div", { class: "pair-code", text: data.code || "" }));
    stateDiv.appendChild(el("div", { class: "row" }, [
      copyButton(() => data.code, "Copy code"),
      actionButton("Cancel", async () => {
        try {
          await api(`/api/v1/admin/pairings/${encodeURIComponent(currentId)}`, { method: "DELETE" });
          live.textContent = "Cancelled";
          stateDiv.replaceChildren();
          stopTimers();
        } catch (e) { live.textContent = e.message; }
      }, { danger: true }),
    ]));
    const countdown = el("div", { class: "muted" });
    stateDiv.appendChild(countdown);
    if (countdownTimer) clearInterval(countdownTimer);
    const expiry = new Date(data.expiresAt).getTime();
    const tick = () => {
      const left = Math.max(0, expiry - Date.now());
      countdown.textContent = `Expires in ${Math.ceil(left / 1000)}s`;
      if (left <= 0 && countdownTimer) clearInterval(countdownTimer);
    };
    tick();
    countdownTimer = setInterval(tick, 500);
  }

  async function poll() {
    if (!currentId) return;
    try {
      const data = await api(`/api/v1/admin/pairings/${encodeURIComponent(currentId)}`);
      if (data.status === "awaiting_approval") {
        live.textContent = "Awaiting approval";
        stateDiv.replaceChildren(
          el("div", { text: "Device is waiting for approval." }),
          el("div", { class: "row" }, [actionButton("Approve", async () => {
            try {
              await api(`/api/v1/admin/pairings/${encodeURIComponent(currentId)}/approve`, { method: "POST" });
              live.textContent = "Approved";
              toast("Pairing approved", "ok");
            } catch (e) { live.textContent = e.message; }
          }, { primary: true })]),
        );
      } else if (data.status === "claimed") {
        live.textContent = "Device paired";
        stateDiv.replaceChildren(el("div", { text: `Device ${data.deviceId || ""} paired.` }));
        stopTimers();
      } else if (data.status === "expired" || data.status === "revoked") {
        live.textContent = "Expired or cancelled";
        stopTimers();
      }
    } catch (e) { live.textContent = e.message; }
  }

  function startPolling() {
    stopTimers();
    pollTimer = setInterval(poll, 2000);
  }

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  return () => stopTimers();
}
