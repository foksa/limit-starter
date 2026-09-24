import type { RPCSchema } from "electrobun/main";
import type { Config } from "../core/config";
import type { ModelOption } from "../core/providers/codex";
import type { Provider } from "../core/types";

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
