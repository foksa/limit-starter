import type { RPCSchema } from "electrobun/main";
import type { Config, LimitWindow, ModelOption, Provider, UpdatePhase } from "./types";

export interface SettingsPayload {
  config: Config;
  launchAtLogin: boolean;
  /** false when running outside a .app bundle (dev), where launch-at-login can't work */
  canLaunchAtLogin: boolean;
  claudeModels: ModelOption[];
}

export type SettingsRPC = {
  bun: RPCSchema<{
    requests: {
      getSettings: { params: {}; response: SettingsPayload };
      listCodexModels: { params: { bin: string }; response: { models: ModelOption[] } | { error: string } };
      saveSettings: { params: { config: Config; launchAtLogin: boolean }; response: { ok: true } | { ok: false; error: string } };
      testModel: {
        params: { provider: Provider; config: Config };
        response: { ok: true; reply: string } | { ok: false; error: string };
      };
    };
    messages: {
      closeSettings: {};
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};

export interface PanelProvider {
  id: Provider;
  label: string;
  model: string;
  enabled: boolean;
  busy: boolean;
  /** what a busy provider is doing; a start includes a ~90 s confirmation wait */
  activity: "checking" | "starting" | "";
  /** null until the first check */
  fiveHour: LimitWindow | null;
  weekly: LimitWindow | null;
  error?: string;
}

export interface PanelState {
  providers: PanelProvider[];
  autoStart: boolean;
  /** outside active hours: nothing is checked or started */
  resting: boolean;
  activeFrom: string | null;
  update: { phase: UpdatePhase; version: string };
}

export type PanelAction =
  | { name: "check" | "toggleAuto" | "settings" | "log" | "updateCheck" | "updateInstall" | "quit" }
  | { name: "start"; provider: Provider };

export type PanelRPC = {
  bun: RPCSchema<{
    requests: {
      getState: { params: {}; response: PanelState };
    };
    messages: {
      action: PanelAction;
      /** content height, so the window can fit it */
      resize: { height: number };
      close: {};
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      state: PanelState;
    };
  }>;
};
