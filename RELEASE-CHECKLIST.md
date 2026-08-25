# Release checklist: verifying the updater

The auto-updater ships across a version hop, so **the code in a release is only
exercised by the NEXT release**. A build's own updater is proven by whether the
build after it lands, not by the build itself. This checklist is how a release
runner confirms it, because the paths that matter most are the ones a clean,
successful release never touches.

## The proving hop

`0.4.6` is delivered by `0.4.5`'s updater, so `0.4.6` arriving proves the OLD
code worked. Only a hop AFTER `0.4.6` runs the code we wrote. Cut a throwaway
`0.4.7` whose only job is to be found and installed.

**Release gate (hard): `0.4.7` must be a COMPLETE signed, notarized, stapled run
of the real pipeline, not a `git tag` and not a version bump.** macOS updates
through Squirrel.Mac, which needs `mac-universal.zip` + its `.blockmap` +
`latest-mac.yml` (whose `path:` must point at the zip, not the dmg). A release
missing those silently falls back to manual and proves nothing.

## What a clean 0.4.7 proves on its own (the happy path)

Install `0.4.6`, publish a complete `0.4.7`, then watch one client:

- [ ] the badge moves check -> available -> downloading -> downloaded on its own
- [ ] at `downloaded` the badge's primary action is **restart**, not a manual download
- [ ] clicking it quits, installs `0.4.7`, and relaunches into the new version
- [ ] after relaunch the badge shows the "just updated" state

## What a clean release CANNOT reach (inject these by hand)

These only run when a user is already in trouble, so a healthy release never
exercises them. A skipped check here means they ship unwitnessed.

- [ ] **Timeout, fallback, and the error-state link (guards `updater.ts` + #325).**
  Cut the network, then trigger a check. Within ~30s the badge must reach an
  **error** state, never a permanent `checking` spinner, and offer a working
  download link (releases page). Restore the network; the next check recovers.
- [ ] **Restart re-entry (#324).** With an update staged at `downloaded`, click
  restart twice in quick succession. It must NOT wedge with "The command is
  disabled and cannot be executed"; a refused or failed quit reports back and
  the button recovers rather than spinning.
- [ ] **Success is visible (#326).** On the latest version, click the badge. It
  must show a positive "you are on the latest version" acknowledgement, not
  settle silently to a grey chip. (This one needs no real update: verify it on
  any build.)

## Tested vs rc-only (keep this split in every report)

- **Verified without a release** (unit tests, typecheck, and dev `update:simulate`):
  badge state-rendering and click-wiring for every state, and the no-update
  acknowledgement.
- **Only a real signed release can exercise**: `downloadUpdate`, `quitAndInstall`,
  and the Squirrel install itself. Do not let this half borrow the tested half's
  confidence: report which is which.
