type Notifier = (title: string, message: string) => void;

function osascriptNotifier(title: string, message: string) {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  Bun.spawnSync(["osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"`]);
}

let notifier: Notifier = osascriptNotifier;

/** The menu bar app swaps in its native notifications so they show under the app's name. */
export function setNotifier(fn: Notifier) {
  notifier = fn;
}

export function notify(title: string, message: string) {
  try {
    notifier(title, message);
  } catch {
    // notifications are best-effort
  }
}
