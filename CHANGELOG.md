# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-06-30

### Added

- Configurable layout driven by `~/.pi/pi-input-revamp.json`. Each of the four
  border corners (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`) is an
  ordered list of info elements. The file is generated with the defaults on
  first run.
- Bottom-border quadrants, so info can be placed in all four corners.
- Independent animation toggles under `animations`: `typingPulse`,
  `submitFlash`, `metricPulse`, `tokPulse`.
- Explicit, placeable metric elements: `session-cost`, `session-out`,
  `session-hit`, `session-miss` (whole-session totals) and `turn-cost`,
  `turn-out`, `turn-hit`, `turn-miss` (last completed turn).
- New elements: `tok` (live token estimate of the input), `turn`,
  `turn-duration`, and the `ctx-*` family (`ctx-percent`, `ctx-tokens`,
  `ctx-tokens-max`, `ctx-tokens-full`).

### Changed

- `cost`/`out`/`hit`/`miss` were scope-aware (session in the top quadrants,
  turn in the bottom). They are replaced by the explicit `session-*` / `turn-*`
  elements above, which always report the same metric wherever they are placed.
- `formatTokens` now renders whole `K` values (`15.2K` → `15K`) and one decimal
  for `M`.

### Fixed

- Build now typechecks: widened the `thm` type so `getFgAnsi` is recognised.
- Per-element metric pulse no longer mis-fires every frame (state is keyed so
  distinct metrics can't collide).
- Session info is computed once per render instead of twice.

## [1.0.1] - 2026-06-27

Initial published release: rounded input frame, colored π prompt, and a
session metrics bar with the typing/submit/metric pulses and the thinking
equalizer.

[1.1.0]: https://github.com/sebastienservouze/pi-input-revamp/releases/tag/v1.1.0
[1.0.1]: https://github.com/sebastienservouze/pi-input-revamp/releases/tag/v1.0.1
