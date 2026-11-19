import { el, card, actionButton, copyButton, toast } from "../lib/dom.js";

export function mountSetup(main, ctx) {
  const { api } = ctx;

  const wrap = el("div", { class: "setup-wrap" });
  const cardEl = card({ title: "First-time setup", subtitle: "Three quick steps to finish the appliance" });
  const step = el("div", { class: "stack" });
  cardEl.querySelector(".card-body").appendChild(step);
  wrap.appendChild(cardEl);
  main.appendChild(wrap);

  const state = { company: "", timezone: "UTC", password: "", code: "", recovery: null };

  function labelInput(label, type, value, onChange) {
    const input = el("input", { type, value: value || "" });
    input.addEventListener("input", () => onChange(input.value));
    return el("div", { class: "field" }, [el("label", { text: label }), input]);
  }

  function renderIdentity() {
    step.replaceChildren(
      labelInput("Company name", "text", state.company, (v) => { state.company = v; }),
      labelInput("Timezone", "text", state.timezone, (v) => { state.timezone = v; }),
      el("div", { class: "row" }, [actionButton("Next", renderPassword, { primary: true })]),
    );
  }

  function renderPassword() {
    const p1 = labelInput("Admin password", "password", state.password, (v) => { state.password = v; });
    const p2 = labelInput("Confirm password", "password", "", () => {});
    const hint = el("p", { class: "muted", text: "At least 8 characters." });
    const next = actionButton("Next", () => {
      if (state.password.length < 8) { toast("Password too short", "warning"); return; }
      renderCode();
    }, { primary: true });
    step.replaceChildren(p1, p2, hint, el("div", { class: "row" }, [next]));
  }

  function renderCode() {
    const codeInput = labelInput("Setup code", "text", state.code, (v) => {
      state.code = v.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      codeInput.querySelector("input").value = state.code;
    });
    const hint = el("p", { class: "muted", text: "Paste the code from setup-code.txt. Hyphens and spaces are ignored." });
    const submitBtn = actionButton("Complete setup", submit, { primary: true });
    step.replaceChildren(codeInput, hint, el("div", { class: "row" }, [submitBtn]));
  }

  async function submit() {
    try {
      const data = await api("/api/v1/admin/setup", {
        method: "POST",
        body: JSON.stringify({
          code: state.code, password: state.password,
          companyName: state.company, timezone: state.timezone,
        }),
      });
      state.recovery = data.recoveryCode;
      if (data.csrfToken) ctx.setCsrfToken?.(data.csrfToken);
      renderRecovery();
    } catch (e) { toast(e.message, "warning"); }
  }

  function renderRecovery() {
    const pre = el("pre", { text: state.recovery || "" });
    const saved = el("input", { type: "checkbox" });
    const savedLabel = el("label", { text: "I saved this recovery code" });
    const enter = actionButton("Enter dashboard", () => {
      if (!saved.checked) { toast("Please confirm you saved the recovery code", "warning"); return; }
      location.hash = "#/overview";
      ctx.boot?.();
    }, { primary: true });
    step.replaceChildren(
      el("h3", { text: "Save your recovery code" }),
      el("p", { class: "muted", text: "This code can restore admin access. Store it offline." }),
      pre,
      el("div", { class: "row" }, [copyButton(() => state.recovery), savedLabel, saved]),
      el("div", { class: "row" }, [enter]),
    );
  }

  renderIdentity();
  return () => {};
}
