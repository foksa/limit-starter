import Electrobun, { Electroview } from "electrobun/view";
import { fmtShort, fmtTime } from "../shared/format";
import type { PanelAction, PanelProvider, PanelRPC, PanelState } from "../shared/rpc";


const rpc = Electroview.defineRPC<PanelRPC>({
  maxRequestTime: 10_000,
  handlers: { requests: {}, messages: { state: (s) => render(s) } },
});
const electrobun = new Electrobun.Electroview({ rpc });
const api = () => electrobun.rpc!;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (a: PanelAction) => api().send.action(a);

let state: PanelState | null = null;

function el(tag: string, cls = "", text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function fmtDay(ms: number | null): string {
  if (ms === null) return "?";
  return new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function bar(pct: number, kind = ""): HTMLElement {
  const b = el("div", ["bar", kind, pct >= 90 ? "high" : ""].filter(Boolean).join(" "));
  const fill = el("i");
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  b.append(fill);
  return b;
}

function startButton(p: PanelProvider): HTMLElement {
  const start = el("button", "pill", "Start") as HTMLButtonElement;
  start.type = "button";
  start.title = `Start a ${p.label} 5h session now`;
  start.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ name: "start", provider: p.id });
  });
  return start;
}

function providerRow(p: PanelProvider, s: PanelState, now: number): HTMLElement {
  const li = el("li", `row provider ${p.id}`);
  if (!p.enabled) li.classList.add("off");
  const avatar = el("span", `avatar ${p.id}`);
  avatar.append(el("span", "logo"));
  li.append(avatar);

  const main = el("div", "grow");
  const name = el("div", "name", p.label);
  name.append(el("span", "model", p.model));
  main.append(name);

  const side = el("div", "side");
  const w = p.fiveHour;
  const running = !!w?.active && (w.resetsAt === null || w.resetsAt > now);

  if (!p.enabled) {
    main.append(el("div", "detail", "Disabled in Settings"));
  } else if (p.activity === "starting") {
    // The start message plus a 90 s wait: right after a start, Codex can't yet tell
    // a new session from none.
    main.append(el("div", "detail", "Starting 5h session… confirming in about a minute"));
  } else if (p.busy) {
    main.append(el("div", "detail", "Checking…"));
  } else if (s.resting) {
    // No checks at night, but a manual start still works (it checks first).
    main.append(el("div", "detail", `Resting until ${s.activeFrom}`));
    if (!running) side.append(startButton(p));
  } else if (!w) {
    main.append(el("div", "detail", "Not checked yet"));
  } else if (running) {
    const left = w.resetsAt === null ? null : w.resetsAt - now;
    main.append(bar(w.usedPct));
    main.append(el("div", "detail", `${w.usedPct}% used · resets ${fmtTime(w.resetsAt)}`));
    const t = el("div", "left", left === null ? "on" : fmtShort(left));
    t.append(el("small", "", "left"));
    side.append(t);
  } else {
    main.append(el("div", "detail", "No 5h session running"));
    side.append(startButton(p));
  }

  if (p.enabled && p.weekly && !s.resting) {
    main.append(bar(p.weekly.usedPct, "weekly"));
    main.append(el("div", "detail", `Weekly ${p.weekly.usedPct}% · resets ${fmtDay(p.weekly.resetsAt)}`));
  }
  if (p.enabled && p.error) {
    const err = el("div", "detail err", `⚠︎ ${p.error}`);
    err.title = p.error;
    main.append(err);
  }

  li.append(main, side);
  return li;
}

function render(s: PanelState | null = state) {
  if (!s) return;
  state = s;
  const now = Date.now();

  $("providers").replaceChildren(...s.providers.map((p) => providerRow(p, s, now)));

  const resting = $("resting");
  resting.hidden = !s.resting;
  resting.textContent = `Resting until ${s.activeFrom} — no checks outside active hours`;

  $<HTMLInputElement>("autoStart").checked = s.autoStart;
  $("version").textContent = s.appVersion === "dev" ? "dev" : `v${s.appVersion}`;
  $("check").classList.toggle("spin", s.providers.some((p) => p.busy));

  const up = $<HTMLButtonElement>("update");
  const label = $("update-label");
  const { phase, version } = s.update;
  up.disabled = phase === "checking" || phase === "downloading" || phase === "installing";
  up.classList.toggle("ready", phase === "ready");
  label.textContent =
    phase === "checking"
      ? "Checking for updates…"
      : phase === "downloading"
        ? `Downloading version ${version}…`
        : phase === "ready"
          ? `Install version ${version} & restart`
          : phase === "installing"
            ? `Installing version ${version}…`
            : "Check for updates…";

  fit();
}

/** Tell the host how tall the content is, so the window matches it. */
function fit() {
  api().send.resize({ height: Math.ceil($("panel").getBoundingClientRect().height) });
}

document.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (target) send({ name: target.dataset.action as Exclude<PanelAction["name"], "start"> });
});
$("autoStart").addEventListener("change", () => send({ name: "toggleAuto" }));
$("update").addEventListener("click", () =>
  send({ name: state?.update.phase === "ready" ? "updateInstall" : "updateCheck" }),
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api().send.close({});
});

// Countdowns tick locally between state pushes.
setInterval(() => render(), 30_000);

void api()
  .request.getState({})
  .then((s) => render(s));
