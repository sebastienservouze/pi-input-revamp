# @nerisma/pi-input-revamp

Replaces [pi](https://pi.dev)'s input editor with a **full rounded frame**, a
colored **π** prompt character, and a **session metrics bar** built into the
border.

```
┌─ agent · anthropic/claude-sonnet-4-5 · high ───── 0.015$ · 15.2K (2.1K|8.3K) · 12.3% ──╮
│ π hello world                                                                          │
╰────────────────────────────────────────────────────────────────────────────────────────╯
```

![pi-input-revamp preview](./preview.gif)

The border and the π use the active theme's `accent` color. The top bar shows
the agent, model, thinking level, working directory, session duration, tool
count and a live token estimate; the right side shows the session label, context
usage, cost and token totals.

## Installation

```bash
pi install npm:@nerisma/pi-input-revamp
```

Or via `settings.json`:

```json
{
  "packages": ["npm:@nerisma/pi-input-revamp"]
}
```

## How it works

The extension registers a custom editor on `session_start` (and hides the
default footer), subclassing pi's `CustomEditor` and overriding `render(width)`.

**From-scratch rendering.** Instead of calling `super.render()` and
post-processing, it builds every line itself. It reserves columns for the `│`
borders and the ` π ` prefix, then calls the inherited `layoutText()` to
word-wrap the input (which keeps paste markers and grapheme segmentation
intact). The cursor is drawn by inverting the grapheme under it (`\x1b[7m…`),
and each line is padded to the inner width and wrapped in border characters. The
top and bottom borders are produced by `fitRoundedBorder`, which fits a left and
a right text into one line, truncating them when space runs short.

**Session metrics.** On each render it reads the session entries from
`ctx.sessionManager.getEntries()` and aggregates token usage and cost (whole
session, and the current/last turn separately). Context usage comes from
`ctx.getContextUsage()`.

**Tool count.** The extension subscribes to `before_provider_request` and keeps
a reference to the `tools` array packed into the request payload. The count is
read lazily at render time, after the whole hook chain has run, so it reflects
any in-place filtering other extensions apply (for example MCP-bridged tools
that inflate the active set but never reach the wire) and reports exactly what
was sent on the last request. Before the first request it falls back to
`pi.getActiveTools()`.

**Color animations.** Several effects share a brightness engine that parses an
ANSI foreground color to RGB and re-emits it in the **same** terminal mode
(truecolor or 256-color), so the animation is never a no-op on 256-color
terminals:

- *Typing whitening* — characters added are sampled over a sliding window to
  estimate WPM; the border and π lerp toward pure white the faster you type,
  with a fast attack and an exponential release when you stop.
- *Submit flash* — a non-empty → empty text transition triggers a brief white
  border pulse.
- *Metrics pulse* — when the session metrics change, the metric text pulses
  toward white and decays back.
- *Thinking equalizer* — while the model works, a VU-meter bar (`▁▂▃…█`) and a
  status word animate on their own line, driven by an independent sinusoid so
  the border stays at the fixed accent.

Animations run on short `setInterval` timers that request a re-render and stop
themselves once the effect has fully decayed; all timers are cleared in
`dispose()`.

## Compatibility

- pi `>= 0.78`

## License

MIT © Sébastien SERVOUZE
