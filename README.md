# Usage Window Starter

A macOS menu bar app, built with [Electrobun](https://framework.blackboard.sh/electrobun/), that watches the Claude and Codex 5-hour usage limits. When a 5h session has reset and is idle, it sends one short message to start the next one.

Besides the regular check interval (10 min by default), it checks once more right after each running session's reported reset time: 30 s later for Codex, which reports exact seconds, and 90 s for Claude, whose `/usage` shows minutes only. That way the next session starts within about a minute of the reset.

The menu bar shows the time left in each running 5h session, for example `C 4:30 · X 2:18`. It shows `–` when a session is idle, `…` while checking, and `!` after an error. The menu has details for each provider, **Check now**, **Start … 5h session now**, an **Auto-start** toggle, **Settings…**, **Open log**, and **Check for updates…**.

It checks for a new version once a day and downloads it in the background. When it's ready, you get a notification and the menu offers **Install update … & restart**.

It uses only the official CLIs, run headless, with your subscription login. There are no direct API calls:

| | limit check (no model call) | start message |
|---|---|---|
| Claude | `claude -p "/usage"` | `claude -p … --model <model> --tools "" --no-session-persistence` |
| Codex | `codex app-server` → `account/rateLimits/read` | `codex exec --ephemeral -m <model>` |

## Models
- **Claude**: the aliases `haiku`, `sonnet` and `opus` always point to the newest model in that family. A custom full model id also works.
- **Codex**: the list comes live from your installed Codex (`model/list`), so it follows Codex updates. If a saved model is no longer offered, Settings marks it and you get a notification the first time a start message fails.
- Use **Send test message** in Settings to try a model before saving. It uses a tiny bit of your limit, and starts a 5h session if none is running.

## Develop / build
```sh
bun run dev        # hutch run dev: builds and launches the dev app
bun run build      # hutch run build: "build/stable-macos-arm64/Usage Window Starter.app"
bun test           # parsers + scheduling rules
bun run typecheck
```
`USAGE_WINDOW_STARTER_OPEN_SETTINGS=1` opens the settings window on launch. With the built app, run `open --env USAGE_WINDOW_STARTER_OPEN_SETTINGS=1 <app>`.

Hutch installs to `~/.hutch/bin`. Run `hutch electrobun sync` once after cloning to create the `.hutch/devkit` types.

## Release
1. Bump `app.version` in `electrobun.config.ts` and `package.json`, then commit and push.
2. Run `bun run release`. It runs the tests, builds the stable app, and publishes `artifacts/*` as GitHub release `v<version>` with `gh`.

Installed apps fetch `stable-macos-arm64-update.json` from the latest release (`release.baseUrl`). They download a small patch when the release has one for their build, or the full app otherwise. Dev builds never update.

## CLI
A dev tool for checking things without the app, for example what the parser sees after a CLI update. It shares the same config and state. `bun run status` shows each provider's 5h and weekly usage and whether it would start a session now; `bun src/cli.ts start <claude|codex>` sends a start message now; `bun src/cli.ts models` lists the models you can pick.

## Files
- `~/.usage-window-starter/config.json`: settings (edited by the Settings window)
- `~/.usage-window-starter/log.jsonl`: one line per check or start
- `~/.usage-window-starter/state.json`: last snapshot and start time for each provider
- `~/Library/LaunchAgents/com.usage-window-starter.login.plist`: only when **Launch at login** is on

If a CLI update changes the `/usage` text, the Claude check fails loudly. No start message is sent, and the menu bar shows `!`. Update `parseUsage` in `src/core/providers/claude.ts` and add the new output to `test/fixtures/`.

## License

[MIT](LICENSE)
