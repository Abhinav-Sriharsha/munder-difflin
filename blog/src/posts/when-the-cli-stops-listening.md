---
title: "When the CLI Stops Listening: Rate Limits Are Silent Data Loss"
description: "A rate-limited coding CLI doesn't reject your input — it discards it. No error, no bounce, no record. Munder Difflin was typing into that void for months. Here's how we detect the wall, hold the whole account behind it, and drain the backlog on the other side."
date: 2026-08-11
category: internals
categoryLabel: Internals
type: Technical
primaryKeyword: "claude code rate limit"
secondaryKeywords: ["claude code usage limit reached", "claude code session limit resets", "cli agent rate limit handling", "queue messages during rate limit", "codex rate limit resets_at"]
tags: ["Internals", "Reliability", "Agents", "Release", "Open Source"]
author:
  name: Chaitanya Giri
  initials: CG
faq:
  - q: "What happens if you type into a rate-limited Claude Code session?"
    a: "The TUI accepts the keystrokes and discards them. There is no error, no bounce, and no record that a message existed — the input area simply clears. Anything sent during the limit window is gone, and the only symptom is noticing later that the agent never did the thing you asked. This is why a rate limit is worse than an outage for an automated sender: an outage fails loudly, and this fails silently."
  - q: "How do you detect a usage limit from a CLI's terminal output?"
    a: "You read the terminal stream, not the exit code — these are TUIs, and the limit is a banner rather than a status. Most CLIs relay the provider's own wording, so generic natural-language patterns carry most of the work, with a small per-CLI table for the strings a tool genuinely owns (Claude Code's subscription limits are its own concept, for example). The hard part is negative matching: Claude renders 'Approaching session limit · resets 3pm' from the same component as the real banner at around 80% usage, and matching that would stand your fleet down hours early, every session."
  - q: "Should a rate-limit hold apply to one agent or all of them?"
    a: "The account. A usage limit belongs to a subscription, so every agent running that CLI is already behind the same wall the moment one of them hits it — they just haven't spoken yet. Holding only the agent that printed the banner lets the others walk into it one at a time, losing a message each. Over-holding costs a wait; under-holding costs instructions."
  - q: "Why not just retry when a message fails to send?"
    a: "Because it doesn't fail. The write succeeds — the bytes reach the pseudo-terminal, and the TUI throws them away at the other end. There is no failure to retry against, which is why the fix has to be a gate in front of the send rather than a retry behind it."
---

There is a failure mode that is worse than an error, and most automated systems are built as
though it doesn't exist: the write that succeeds and does nothing.

Munder Difflin drives coding CLIs — Claude Code, Codex, Grok, and half a dozen others — through
real pseudo-terminals. It types into them the way a person would. And for months, whenever one of
those CLIs hit its usage limit, the harness kept typing.

The keystrokes landed. The pty accepted them. The TUI discarded them.

No error. No bounce. No record that a message ever existed. The input area just cleared, and an
instruction that someone had queued an hour earlier ceased to exist. The only symptom was noticing,
much later, that an agent never did the thing it was asked.

## Why this is not a retry problem

The instinct is to add a retry. It doesn't apply here, and the reason is worth sitting with.

A retry needs a failure to hang off. Ours succeeded at every layer we could observe:

```
write(ptyFd, "…")   →  ok, bytes written
pty                 →  ok, delivered to the child
TUI                 →  reads the input, sees it is rate limited, drops it
```

There is nothing to catch. By the time the message is lost, every call in the stack has already
returned success. That pushes the fix upstream of the send: you cannot recover from this
afterwards, so you have to not do it in the first place.

## Reading the wall

Because these are TUIs, the limit is a banner rather than a status code. So you read the terminal
stream.

The obvious design is a table of per-CLI strings — the shape we already use for slash commands,
where `/compact` differs per tool. Reading the shipped artefacts of the installed fleet, that turns
out to be the wrong shape, because **the limit text is mostly written by the API, not the CLI**.
Five of the CLIs we drive contain no user-facing limit copy at all; they surface whatever the
provider returned. What reaches the terminal is the provider's phrasing, not the tool's.

So generic patterns carry the weight, and a small table covers the strings a CLI genuinely owns —
Claude Code's subscription limits, for instance, are its own concept, with a fixed label set
(`session limit`, `weekly limit`, `Opus limit`, `Sonnet limit`).

One nice piece of corroboration: pi.dev ships its own two classifier regexes, and the line it draws
is the same line we drew independently — terminal quota conditions on one side, retryable transport
errors on the other.

### The pattern that would have broken everything

Claude Code renders this at around 80% usage:

```
Approaching session limit · resets 3pm
```

From the same component as the real banner. Matching the reset clause alone would have stood the
entire fleet down hours early, every single session — turning a feature that exists to prevent lost
work into the largest source of lost time in the app.

It is the first thing the negative filter rejects, and it has a test. The general lesson: when you
add detection to a system, the false positive is not an edge case to handle later. It is the thing
most likely to make the feature a net negative, and it deserves the first test you write.

There is a second class of false positive specific to a harness like this: agents read source code
and echo it to their terminals. A file containing `const RATE_LIMIT = 120;` scrolls past and looks,
to a naive matcher, exactly like a rate limit. Code-shaped contexts are filtered, and lines over
400 characters — a minified bundle going by — are ignored outright.

## Two tiers, because they want opposite responses

Conflating these would be the worst bug the feature could ship:

| | what it is | response |
|---|---|---|
| **throttle** | burst 429, "overloaded", "temporarily limiting requests" | seconds to minutes — **off by default**, the CLIs already retry these |
| **quota** | the plan's allowance is spent | hold until the stated reset |

Parking a whole floor for hours because of a transient 503 that cleared in four seconds is not a
safety feature. It is an outage you caused yourself.

## The hold belongs to the account

A usage limit is a property of a subscription, not a process. Six workers running `claude` share
one account, so the moment one of them hits the wall the other five are already behind it — they
simply haven't spoken yet.

Holding only the agent that printed the banner would let the next five walk into the same wall one
at a time, losing a message each on the way in. So the hold is scoped to the provider.

That over-holds if you deliberately run two accounts across different agents, and that trade is
made on purpose: **over-holding costs a wait, under-holding costs instructions.** Resume is one
click, and every hold shows the line of terminal output that caused it, so a wrong hold is visible
rather than mysterious.

## Telling a repaint from a real re-hit

TUIs redraw constantly, and the banner stays in the scrollback after the limit lifts. A naive
detector re-arms on its own echo forever.

Two mechanisms, and the second is the interesting one:

- the detector suppresses an identical evidence line within a short window;
- the gate refuses to re-arm from identical wording shortly after a release **unless a message has
  actually been delivered since**.

That second condition is what separates an echo from a genuine second rejection. If we sent
something and the wall is still there, that is new information. If we sent nothing, we are looking
at pixels we already reacted to. There is a test that feeds thirty frames of the same banner at
roughly 10fps and asserts exactly one hold.

## What is gated, and what deliberately is not

**Gated:** the queue drain, the spawn seed — an agent seeded into a capped provider has its entire
setup prompt discarded and then sits there looking like a hung spawn — and scheduled auto-compact,
because `/compact` is a model call that spends a rejected attempt *and* parks a `/compact` ahead of
your real backlog when the window reopens.

**Not gated:** writing a message into another agent's inbox file. That is already a queue — the
message waits on disk until the agent next runs — so gating it would convert "delayed" into "lost",
which is the exact bug we are fixing.

**Bypassed:** "send now" overrides a hold, exactly as it already overrides the floor-wide delivery
pause. One override, one meaning. The operator may know something the detector doesn't, and an
override with no escape hatch is worse than a wrong guess.

## Two bugs found while building it

Both are the same species — a setting that describes the world rather than controlling it.

**`autoResume: off` did nothing.** Expiry was a timestamp comparison, so holds lapsed on their own
and the setting was decorative. A hold now ends when it is *swept*, and the sweep is what
auto-resume controls.

**Disabling the guard left the floor stopped.** The drain reads the hold list, not the setting, so
existing holds outlived the switch that was supposed to govern them. Turning it off now releases
everything.

If you take one thing from this post, take that pattern: a boolean that reads well in the UI and is
never consulted on the path it claims to govern is indistinguishable from a working feature right up
until someone needs it.

## What honest verification looks like

The detection tests are built from strings read out of the installed binaries — `strings` and
`rg` over the shipped artefacts — not from a terminal that actually hit a wall. That is a real
limitation and it is worth stating plainly rather than burying: the highest-value check before
trusting this is forcing one live limit and watching a queue drain on the other side of it.

Shipping detection heuristics with a switch to turn them off, evidence attached to every decision,
and a one-click override is not a lack of confidence. It is what you owe people when your feature's
failure mode is "the fleet stopped and I don't know why".

---

*Munder Difflin v0.3.8 is out — usage-limit aware delivery, a Triggers hub, and a git history view
that finally fits its panel. [Download it](https://github.com/chaitanyagiri/munder-difflin/releases/latest),
or read the [changelog](https://github.com/chaitanyagiri/munder-difflin/blob/main/CHANGELOG.md).*
