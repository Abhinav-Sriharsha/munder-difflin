# Munder Difflin v0.4.4

**A local hive of Claude Code, Antigravity, Codex, Grok & Copilot agents that run themselves** — messaging,
routing, and remembering, coordinated by your clone, Michael, who you talk to. Local-first and open source.

### → [**munderdiffl.in**](https://munderdiffl.in/) — see it in action, then grab a build below

---

## What's new in 0.4.4 — *Windows agents can finally talk to each other*

**On Windows, agents were never told they could message each other.** They started, rendered,
and looked perfectly healthy — but a multi-line prompt handed to a CLI through `cmd.exe` is cut
off at its first newline, and the part that got cut was the protocol block naming an agent's
inbox and outbox. So no agent ever wrote mail, and none ever arrived.

- **Agent-to-agent messaging works on Windows.** Prompt-carrying spawns now run the CLI's real
  interpreter directly instead of routing through `cmd.exe`, so the whole protocol survives.
  Anything we can't decode falls back to exactly today's behaviour.
- **Setup can finish again.** Accepting the suggested `~/HarnessAgents` folder wrote a literal
  `~`, and the wizard then died on `ENOENT: mkdir '~/HarnessAgents'` with the interface pushed
  off-screen — on the very first thing a new user does.
- **Copying from a terminal is clean.** The Edit menu was intercepting ⌘C before the terminal
  saw it, so copies came back with the wrong text *and* with `—` mangled into `‚Äî`.
- **Agent terminals are UTF-8.** They ran with no locale at all, so tools inside them fell back
  to a 1980s character set and miscounted any non-English text.
- **Screenshots are visible.** Images open in the IDE instead of "binary file (not displayable)",
  and agent-written markdown reports finally render the screenshots they embed.
- **The IDE says whose workspace you're in**, and points out the search shortcuts (⌘F, F1) that
  were already there.
- **This notice tells you what changed.** Updates used to announce only a version number.
- Task cards no longer vanish when two things edit the board at once; idle agents stop being
  asked to compact every hour; "Restart & Continue" works on an agent that already died; an
  unusual message id no longer silences an agent's mail permanently; the office floor stops
  rendering while you're in a fullscreen terminal; Grok 4.6 is selectable.

> [!NOTE]
> **Windows users:** this is the release that makes multi-agent work on Windows at all. If you
> tried it before and your agents sat there ignoring each other, that was this bug.

---

## Still new in 0.4.3 — *Michael is the logo*

**The mark is a face now.** Munder Difflin has always been an office you watch people work in,
and the icon was a pair of script initials on a gradient. It's Michael — your clone — drawn in
the app's own pixel art, on the brand yellow, looking straight back at you.

- **One mark, everywhere.** The dock icon on macOS, Windows and Linux, the site favicon and
  header, the in-app toolbar, and the README all render the same portrait. No variant is a
  redrawing of another.
- **The SVG is the source of truth.** The mark is authored as pure vector — every pixel of the
  sprite is a rect, with no fonts, no gradients and no filters — and every raster in `build/`
  and `docs/` is generated from it by [`tools/make-logo.cjs`](https://github.com/chaitanyagiri/munder-difflin/blob/main/tools/make-logo.cjs).
  The old icon depended on the Lobster webfont being installed to render correctly.
- **Icons are native at every size.** A real multi-resolution `.icns` (16→1024, with the macOS
  drop shadow) and a `.ico` carrying six sizes, plus a 32px favicon and a 180px apple-touch-icon,
  so nothing is a downscale of a 512px image any more.
- **Brighter call-to-action buttons.** The download button took its fill from the same token as
  accent *text*, which has to stay dark enough to read on a white page — so on the light theme
  it came out brown. Fills now have their own token and start at what used to be the hover colour.

> [!NOTE]
> **Appearance only.** No functional change in this release: the update carries the new icon into
> your dock, and nothing else moves.

---

## Still new in 0.4.2 — *Anonymous usage stats, done in the open*

Munder Difflin now sends a **small set of anonymous usage events** (app opened, agent spawned,
feature used) so we can tell whether features are actually used. It is built the way an
open-source project should build it:

- **[TELEMETRY.md](https://github.com/chaitanyagiri/munder-difflin/blob/main/TELEMETRY.md) is the
  complete contract.** Every event and property is listed there, and the code enforces that list
  as a hard allowlist — anything not in the table cannot be sent. No prompts, no transcripts, no
  file paths, no repo names, no identifiers. Events are PostHog *anonymous events* (no person
  profile, no identity), keyed by a random UUID you can delete.
- **Opt-out, three ways.** Uncheck it during onboarding, flip **Settings → General → Anonymous
  usage stats**, or set the standard `DO_NOT_TRACK` env var.
- **Forks send nothing.** The analytics key is injected only in release CI — building from
  source produces a build where the analytics module is a complete no-op.

---

## Still new in 0.4.1 — *The app says what the site says*

**Michael is your clone.** The website has been describing Munder Difflin as a clone of you that
works around the clock — the app still called it a "GOD agent." Now they match.

- **Your clone, not the GOD agent.** Michael is described as your clone throughout onboarding,
  and his card on the floor carries a **BOSS** tag — he's the boss of the agents, you're still
  the boss of him.
- **Onboarding was rewritten.** It opens on what you actually get ("a clone of you, working
  24/7") instead of a feature list, and the engine card no longer advertises three engines when
  ten ship — Claude Code, Codex, Grok, Kimi, Antigravity, Qwen, OpenCode, Crush, pi and Copilot
  are all named.

> [!NOTE]
> **This release changes wording only.** The `god` agent id, the hive folder layout, and message
> routing are untouched, so existing hives, memory, and running agents carry over exactly as they
> are. Nothing to migrate.

---

> [!NOTE]
> **Auto-update carries you here from v0.3.7 or later.** If you are still on v0.3.5 or v0.3.6,
> those builds shipped the broken updater and need one manual install — grab the download below,
> once.

---

## Previously

- **0.4.0** — *the brand grew up*: one yellow "MD" mark across the dock icon, in-app logo, site
  favicon, and munderdiffl.in; the landing page rebuilt around real screenshots and a live
  pixel-floor sim; pricing reframed around **Private Cloud** and **Private Network**.
- **0.3.9** — Settings → General answers "am I up to date?" directly, and removes 0.3.8's
  usage-limit guard that never released held agents.
- **0.3.8** — memory condensation works for the first time; a Triggers hub; one compaction
  schedule instead of two; a readable commit history.
- **0.3.7** — auto-update actually runs: a CommonJS/ESM import bug meant the native updater never
  fired in any packaged build since v0.3.4, and the failure was swallowed by a `catch`.
- **0.3.6** — *a machine with nothing on it can run agents*: Node and npm install themselves
  (verified against the official `SHASUMS256.txt`), hooks stopped dying with exit 127, `~/dev/foo`
  paths resolve, and the office floor rebuilds itself after losing its GPU context.
- **0.3.5** — a **send now** escape hatch for a paused message queue, and a compact Command
  Center header.
- **0.3.4** — talk mode that knows the floor, markdown previews, the IDE git time-machine
  (history + branch compare), redesigned Settings, xAI Grok and Kimi Code, and a single
  delivery gate for every automatic writer. Community work by
  [@gts-47](https://github.com/gts-47) and [@qschmick](https://github.com/qschmick).
- **0.3.3** — the built-in Monaco IDE, and GitHub Copilot CLI as the first community-contributed
  engine ([@anxkhn](https://github.com/anxkhn)).
- **0.3.2** — Realtime Michael: a voice channel to the GOD orchestrator.
- **0.3.1** — three more engines: OpenCode, Crush, and pi.dev.

Full history in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).


## ⤓ Downloads

Latest builds for every platform. The macOS build is **universal** — one DMG that runs on both
Apple Silicon and Intel.

### 🍎 macOS
| Build | File |
|---|---|
| Universal (Apple Silicon + Intel) | [`Munder-Difflin-0.4.4-mac-universal.dmg`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.4-mac-universal.dmg) |

### 🪟 Windows
| Build | File |
|---|---|
| Installer (x64) — *recommended* | [`Munder-Difflin-0.4.4-win-x64-setup.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.4-win-x64-setup.exe) |
| Portable (x64, no install) | [`Munder-Difflin-0.4.4-win-x64-portable.exe`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.4-win-x64-portable.exe) |

### 🐧 Linux
| Build | File |
|---|---|
| AppImage (x86_64) | [`Munder-Difflin-0.4.4-linux-x86_64.AppImage`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/Munder-Difflin-0.4.4-linux-x86_64.AppImage) |

### 📦 Source
[Source code (zip)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.4.4.zip) ·
[Source code (tar.gz)](https://github.com/chaitanyagiri/munder-difflin/archive/refs/tags/v0.4.4.tar.gz)

> **Verify your download:** [`SHA256SUMS.txt`](https://github.com/chaitanyagiri/munder-difflin/releases/latest/download/SHA256SUMS.txt) — then `shasum -a 256 -c SHA256SUMS.txt` (macOS/Linux) or `Get-FileHash` (Windows).

> The filenames above carry a version number, so they only resolve while this is the
> latest release. If a link 404s you are reading an old release page — grab the current
> build from the [**releases page**](https://github.com/chaitanyagiri/munder-difflin/releases/latest),
> which is always right.

---

## First launch

- **macOS** — the build is **signed with a Developer ID** (hardened runtime). If macOS
  still shows an "unidentified developer" warning on first open, right-click the app →
  **Open** → **Open** once. After that, the first time agents touch a folder you'll get a
  single macOS privacy prompt for Documents/Desktop/Downloads — allow it once and the
  grant sticks (it covers the `claude` agents the app spawns), because the grant is bound
  to the app's stable signature.
- **Windows** — not code-signed yet; SmartScreen may show "Windows protected your PC" →
  **More info** → **Run anyway**.
- **Linux** — make the AppImage executable: `chmod +x Munder-Difflin-*.AppImage`, then run it.

---

## Requirements
- macOS 12+, Windows 10/11, or a modern Linux desktop
- [Claude Code](https://claude.com/claude-code) installed and on your `PATH` (and/or the Antigravity `agy` or OpenAI `codex` CLI for those providers)
- A Claude Code subscription (Munder Difflin drives your existing `claude` CLI — it doesn't replace it)
- For **Realtime Michael** (voice): your own **OpenAI key with Realtime API access** — without it the **Talk** button stays disabled

---

## 🛠 Build from source
```bash
git clone https://github.com/chaitanyagiri/munder-difflin.git
cd munder-difflin
npm install        # rebuilds node-pty for Electron
npm run dev        # launches the app with hot reload
```
Node 18+ and a C/C++ toolchain are required (Xcode CLT on macOS, Build Tools on Windows).
To produce installers yourself: `npm run dist` (current OS), or `dist:mac` / `dist:win` / `dist:linux`.

---

## What's inside
- **The simulation** — every agent is a real `claude` (or `agy` / `codex` / local-provider) pseudo-terminal, visualized as an avatar on a watchable office floor (`node-pty` · `xterm.js` · Pixi.js).
- **Talk to Michael** — a realtime **voice channel to the GOD orchestrator** that reads the hive and acts behind spoken echo-back confirmation, BYOK and main-only.
- **Selectable engines + per-hire capabilities** — each hire (and Michael himself) runs on a pluggable engine, with its own consented skills + MCP catalog.
- **MemPalace** — a markdown-first, semantic memory layer the whole office shares; cross-session recall in ~12ms.
- **GOD orchestrator + hive** — one agent you talk to routes work to specialists and stays autonomous, escalating only critical items (spend, destructive ops, scope) to you natively, through human-in-the-loop prompts. It can also spawn an ephemeral worker straight from Slack and tear it down safely.
- **Plugs into your setup** — your subscription, settings, skills, and MCP servers, plus an integrations registry with a write-only secret broker; `/remote-control` reaches the whole floor from your phone.

Full notes in the [CHANGELOG](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).

---

## Links
[Website](https://munderdiffl.in/) ·
[Repo](https://github.com/chaitanyagiri/munder-difflin) ·
[Issues](https://github.com/chaitanyagiri/munder-difflin/issues) ·
[Contribute](https://github.com/chaitanyagiri/munder-difflin/blob/main/CONTRIBUTING.md) ·
[Become a patron](https://razorpay.me/@munderdifflinfund)

MIT-licensed. An affectionate parody — not affiliated with NBC's *The Office* or Dunder Mifflin.
