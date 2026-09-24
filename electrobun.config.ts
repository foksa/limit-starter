import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "limit-starter",
    identifier: "dev.limit-starter.app",
    version: "0.2.0",
  },
  runtime: {
    // It's a menu bar app: closing the settings window must not quit it.
    exitOnLastWindowClosed: false,
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      settings: {
        entrypoint: "src/settings/index.ts",
      },
    },
    copy: {
      "src/settings/index.html": "views/settings/index.html",
      "src/settings/index.css": "views/settings/index.css",
      "assets/tray-template.png": "views/assets/tray-template.png",
    },
    mac: {
      bundleCEF: false,
      createDmg: false,
    },
  },
} satisfies ElectrobunConfig;
