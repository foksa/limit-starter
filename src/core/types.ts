export type Provider = "claude" | "codex";
export const PROVIDERS: Provider[] = ["claude", "codex"];

export interface LimitWindow {
  /** true while a window is running (it has a reset time in the future) */
  active: boolean;
  usedPct: number;
  /** epoch ms, null when idle or unknown */
  resetsAt: number | null;
}

export interface Snapshot {
  fiveHour: LimitWindow;
  weekly: LimitWindow | null;
}

export interface ProviderState {
  lastCheckAt?: number;
  lastSnapshot?: Snapshot;
  lastStartAt?: number;
  lastDecision?: string;
  lastError?: string;
  consecutiveFailures?: number;
  failureNotified?: boolean;
}

export type State = Partial<Record<Provider, ProviderState>>;
