/**
 * pi-input-revamp — pi TUI extension
 *
 * Replaces pi's input editor (the prompt bar) with a full rounded frame, a π
 * prompt character, tightly controlled spacing, and fully configurable info
 * elements in all four quadrants of the border.
 *
 * ┌─ agent · anthropic/claude-sonnet-4-5 · high ──── 0.015$ · 15.2K (2.1K|8.3K) · 12.3% ─╮
 * │ π hello world                                                                          │
 * ╰─────────────────────────────────────────────────── T5 · 0.015$ · OUT 8.3K ─────────────╯
 *
 * Layout is controlled by ~/.pi/pi-input-revamp.json:
 *
 *   {
 *     "layout": {
 *       "topLeft": ["agent", "model", "thinking-level", ...],
 *       "topRight": ["session-label", "cost", "out", ...],
 *       "bottomLeft": [],
 *       "bottomRight": ["turn", "cost", "out", ...]
 *     },
 *     "animations": { "typingPulse": true, ... }
 *   }
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ── Configuration types ──────────────────────────────────

type ElementId =
  | "agent" | "model" | "thinking-level" | "cwd"
  | "duration" | "tools" | "tok"
  | "session-label"
  | "ctx-percent" | "ctx-tokens" | "ctx-tokens-max" | "ctx-tokens-full"
  | "session-cost" | "session-out" | "session-hit" | "session-miss"
  | "turn-cost" | "turn-out" | "turn-hit" | "turn-miss"
  | "turn" | "turn-duration";

interface InputRevampConfig {
  layout: {
    topLeft: ElementId[];
    topRight: ElementId[];
    bottomLeft: ElementId[];
    bottomRight: ElementId[];
  };
  animations: {
    typingPulse: boolean;
    submitFlash: boolean;
    metricPulse: boolean;
    tokPulse: boolean;
  };
}

const DEFAULT_CONFIG: InputRevampConfig = {
  layout: {
    topLeft: ["agent", "model", "thinking-level", "cwd", "duration", "tools", "tok"],
    topRight: ["session-label", "ctx-percent", "ctx-tokens-full", "session-cost", "session-out", "session-hit", "session-miss"],
    bottomLeft: [],
    bottomRight: ["turn", "turn-duration", "turn-cost", "turn-out", "turn-hit", "turn-miss"],
  },
  animations: {
    typingPulse: true,
    submitFlash: true,
    metricPulse: true,
    tokPulse: true,
  },
};

function writeDefaultConfig(path: string): void {
  try {
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort: if we can't write, just use defaults in-memory
  }
}

function loadConfig(): InputRevampConfig {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const configPath = `${home}/.pi/pi-input-revamp.json`;
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<InputRevampConfig>;
      // Merge with defaults so missing fields fall back
      return {
        layout: {
          topLeft: Array.isArray(parsed.layout?.topLeft)
            ? parsed.layout!.topLeft
            : DEFAULT_CONFIG.layout.topLeft,
          topRight: Array.isArray(parsed.layout?.topRight)
            ? parsed.layout!.topRight
            : DEFAULT_CONFIG.layout.topRight,
          bottomLeft: Array.isArray(parsed.layout?.bottomLeft)
            ? parsed.layout!.bottomLeft
            : DEFAULT_CONFIG.layout.bottomLeft,
          bottomRight: Array.isArray(parsed.layout?.bottomRight)
            ? parsed.layout!.bottomRight
            : DEFAULT_CONFIG.layout.bottomRight,
        },
        animations: {
          typingPulse:
            parsed.animations?.typingPulse ?? DEFAULT_CONFIG.animations.typingPulse,
          submitFlash:
            parsed.animations?.submitFlash ?? DEFAULT_CONFIG.animations.submitFlash,
          metricPulse:
            parsed.animations?.metricPulse ?? DEFAULT_CONFIG.animations.metricPulse,
          tokPulse:
            parsed.animations?.tokPulse ?? DEFAULT_CONFIG.animations.tokPulse,
        },
      };
    }

    // File doesn't exist → create it with defaults, then return defaults
    writeDefaultConfig(configPath);
  } catch {
    // Silently fall back to defaults
  }
  return {
    ...DEFAULT_CONFIG,
    layout: { ...DEFAULT_CONFIG.layout },
    animations: { ...DEFAULT_CONFIG.animations },
  };
}

// ── Tools actually sent on the wire ───────────────────────

/**
 * Tools array captured (by reference) from the last provider request payload.
 *
 * Held by reference, not snapshotted: it is read lazily at render time, after
 * the whole `before_provider_request` hook chain has run. Other extensions may
 * filter this array in place (e.g. removing MCP-bridged tools that pollute the
 * active set but never reach the wire), so reading it late reports exactly what
 * was sent — regardless of extension load order.
 */
let lastWirePayloadTools: unknown[] | null = null;

/**
 * Finds the `tools` array inside a provider request payload (shape is
 * `unknown` and provider-specific). Tries the common locations.
 */
function findToolsArray(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const nested = (k: string) => (p[k] as Record<string, unknown> | undefined)?.tools;
  for (const c of [p.tools, nested("body"), nested("request"), nested("params")]) {
    if (Array.isArray(c)) return c;
  }
  return null;
}

/** Name of a tool entry, whatever the wire format (OpenAI / Anthropic / pi). */
function toolName(t: unknown): string | undefined {
  if (!t || typeof t !== "object") return undefined;
  const o = t as { name?: string; function?: { name?: string } };
  return o.name ?? o.function?.name;
}

/**
 * Names of the tools actually sent to the provider on the last request.
 *
 * Prefers the wire truth read from the captured payload; falls back to the
 * active set before the first request (or if no tools array is found).
 */
function effectiveToolNames(pi: ExtensionAPI): string[] {
  if (lastWirePayloadTools) {
    const names = lastWirePayloadTools
      .map(toolName)
      .filter((n): n is string => n !== undefined);
    if (names.length > 0) return names;
  }
  return pi.getActiveTools();
}

// ── Formatting helpers ────────────────────────────────────

/** Formats a token count (1200 → "1K", 1_500_000 → "1.5M").
 *  < 1M → integer (no decimal), ≥ 1M → one decimal.
 */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return `${count}`;
}

// ── "equalizer" animation (VU-meter-style bars ▁▂▃…█) ──────

/** Default expression for any tool. */
const DEFAULT_TOOL_EXPRESSION = "doing something complex...";

/** Expressions during pure thinking (no tool). */
const THINKING_EXPRESSIONS = [
  "thinking hard...",
  "pondering...",
  "cranking its neurons...",
  "cooking up an answer...",
  "crunching numbers...",
  "stirring its circuits...",
  "shuffling tokens...",
];

/** Last tool currently executing (read by the editor). */
let activeToolName: string | null = null;

// ── Typing-animation settings (whitening ∝ speed) ──────────
/** WPM at which the bar turns fully white. */
const TYPING_WHITE_WPM = 300;
/** Sliding sampling window for typing speed (ms). */
const TYPING_WINDOW_MS = 1000;
/** Cap on characters counted per event (a paste must not whiten all at once). */
const TYPING_DELTA_CAP = 4;
/** Rise toward the target per frame (larger = snappier). */
const TYPING_ATTACK = 0.2;
/** Fall per frame once the debounce elapses. */
const TYPING_RELEASE = 0.80;
/** Debounce (ms): hold intensity after last character before fading. */
const TYPING_IDLE_MS = 150;
/** Cap >1 so the bar stays white at full speed (headroom absorbs flicker). */
const TYPING_MAX = 1.2;
/** Pulse decay per 16ms frame (0.95 ≈ ~1.5s fade). */
const METRIC_RELEASE = 0.95;

/**
 * Builds a horizontal border with text on the left and on the right.
 *
 * @param left   Left text (e.g. " anthropic/claude-sonnet-4-5 · high ")
 * @param right  Right text (e.g. " 0.015$ · 15.2K (2.1K|8.3K) · 12.3% ")
 * @param width  Total line width
 * @param color  Coloring function (this.borderColor)
 * @param top    true → ╭─╮, false → ╰─╯
 */
function fitRoundedBorder(
  left: string,
  right: string,
  width: number,
  color: (s: string) => string,
  top: boolean,
  padLeft: number = 1,
  padRight: number = 1,
): string {
  if (width <= 0) return "";
  if (width === 1) return color(top ? "╭" : "╰");

  const lc = top ? "╭" : "╰";
  const rc = top ? "╮" : "╯";
  const fixedWidth = 2 + padLeft + padRight;
  const minimumGap = 3;

  let leftText = left;
  let rightText = right;

  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(rightText) > 0
  ) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (
    fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
    visibleWidth(leftText) > 0
  ) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }

  const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
  const fill = "─".repeat(gapWidth);
  const padStr = color("─".repeat(padLeft));
  const padStrRight = color("─".repeat(padRight));

  return `${color(lc)}${padStr}${leftText}${color(fill)}${rightText}${padStrRight}${color(rc)}`;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/** Formats a duration in seconds → "5m 12s" or "1h 23m". */
function formatDuration(seconds: number): string {
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

/** Rough token estimate (4 characters ≈ 1 token for a FR/EN/CODE mix). */
function estimateTokens(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Extracts session info from the entries. */
function computeSessionInfo(entries: readonly any[]): {
  turnCount: number;
  sessionStartTs: number;
  lastPromptTs: number | null;
} {
  let turnCount = 0;
  let sessionStartTs = Date.now();
  let lastPromptTs: number | null = null;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const ts = new Date(entry.timestamp).getTime();
    if (!isNaN(ts) && ts < sessionStartTs) sessionStartTs = ts;

    if (entry.message?.role === "user") {
      turnCount++;
      if (!isNaN(ts) && (lastPromptTs === null || ts > lastPromptTs)) lastPromptTs = ts;
    }
  }

  return { turnCount, sessionStartTs, lastPromptTs };
}

/** Computes the cumulative metrics of the assistant messages in the session. */
function computeSessionMetrics(entries: readonly any[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} | null {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      totalInput += entry.message.usage.input ?? 0;
      totalOutput += entry.message.usage.output ?? 0;
      totalCacheRead += entry.message.usage.cacheRead ?? 0;
      totalCacheWrite += entry.message.usage.cacheWrite ?? 0;
      totalCost += entry.message.usage.cost?.total ?? 0;
    }
  }

  if (totalInput === 0 && totalOutput === 0 && totalCost === 0) return null;
  return { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, cost: totalCost };
}

/** Sums the metrics of every assistant message since the last user message. */
function computeLastTurnMetrics(entries: readonly any[]): { input: number; output: number; cacheRead: number; cost: number } | null {
  // Find the last user message (start of the current turn).
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "message" && entries[i].message?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return null;

  // Sum every assistant message after it (multi-tool calls within one turn).
  let input = 0, output = 0, cacheRead = 0, cost = 0;
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      input += entry.message.usage.input ?? 0;
      output += entry.message.usage.output ?? 0;
      cacheRead += entry.message.usage.cacheRead ?? 0;
      cost += entry.message.usage.cost?.total ?? 0;
    }
  }

  if (input > 0 || output > 0 || cacheRead > 0 || cost > 0)
    return { input, output, cacheRead, cost };
  return null;
}

// ── Brightness manipulation, works in BOTH truecolor AND 256-color ──
// pi renders colors in truecolor (\x1b[38;2;r;g;bm) only when COLORTERM=truecolor;
// otherwise in 256-color (\x1b[38;5;Nm). We handle both: parse → RGB, shift the
// brightness in RGB, then re-emit IN THE SAME MODE (otherwise the pulse would be a
// no-op in 256-color).

/** Levels of the xterm-256 6×6×6 color cube ramp. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** 16 xterm system colors (standard RGB approximation). */
const ANSI16_RGB: [number, number, number][] = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

/** Palette-256 index → RGB. */
function ansi256ToRgb(n: number): [number, number, number] {
  if (n < 16) return ANSI16_RGB[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v]; }
  const c = n - 16;
  return [
    CUBE_LEVELS[Math.floor(c / 36) % 6],
    CUBE_LEVELS[Math.floor(c / 6) % 6],
    CUBE_LEVELS[c % 6],
  ];
}

/** Cube level nearest to a channel value (0..255). */
function nearestCubeIndex(v: number): number {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < CUBE_LEVELS.length; i++) {
    const d = Math.abs(CUBE_LEVELS[i] - v);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/** RGB → nearest palette-256 index (cube, or gray ramp if near-neutral). */
function rgbTo256(r: number, g: number, b: number): number {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 10) {
    const gray = Math.round(((r + g + b) / 3 - 8) / 10);
    return 232 + Math.max(0, Math.min(23, gray));
  }
  return 16 + 36 * nearestCubeIndex(r) + 6 * nearestCubeIndex(g) + nearestCubeIndex(b);
}

/** Parses an ANSI fg color (truecolor or 256) → RGB + original mode. */
function parseFgAnsi(ansi: string): { rgb: [number, number, number]; mode: "truecolor" | "256" } | null {
  let m = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], mode: "truecolor" };
  m = ansi.match(/\x1b\[38;5;(\d+)m/);
  if (m) return { rgb: ansi256ToRgb(+m[1]), mode: "256" };
  return null;
}

/**
 * Colors `text` with the accent `baseAnsi` shifted in brightness by `amount`
 * (±RGB per channel). Re-emits in the original mode (truecolor or 256), so the
 * pulse works in both.
 */
function shadeFgAnsi(baseAnsi: string, amount: number, text: string): string {
  const p = parseFgAnsi(baseAnsi);
  if (!p) return `${baseAnsi}${text}\x1b[39m`; // unknown format → raw accent
  const r = Math.max(0, Math.min(255, p.rgb[0] + amount));
  const g = Math.max(0, Math.min(255, p.rgb[1] + amount));
  const b = Math.max(0, Math.min(255, p.rgb[2] + amount));
  const open = p.mode === "truecolor"
    ? `\x1b[38;2;${r};${g};${b}m`
    : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
  return `${open}${text}\x1b[39m`;
}

/**
 * Linearly interpolates `baseAnsi` toward pure white by `t` (0 = accent,
 * 1 = white #ffffff). Unlike shadeFgAnsi (+amount per channel, saturates at 255
 * but keeps the hue when a channel is already high), this lerp guarantees true
 * white at t=1 — which is what the fast-typing effect wants. Re-emits in the
 * original mode (truecolor / 256).
 */
function lerpToWhite(baseAnsi: string, t: number, text: string): string {
  const p = parseFgAnsi(baseAnsi);
  if (!p) return `${baseAnsi}${text}\x1b[39m`;
  const k = Math.max(0, Math.min(1, t));
  const mix = (c: number) => Math.round(c + (255 - c) * k);
  const [r, g, b] = [mix(p.rgb[0]), mix(p.rgb[1]), mix(p.rgb[2])];
  const open = p.mode === "truecolor"
    ? `\x1b[38;2;${r};${g};${b}m`
    : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
  return `${open}${text}\x1b[39m`;
}

interface AnimColors {
  /** accent lightened (amount>0) or darkened (amount<0) by `amount` per RGB channel */
  shade: (s: string, amount: number) => string;
  /** brightness offset of the global pulse (oscillates with the sine, ~ -50..+50) */
  pulseOffset: number;
}

/**
 * Renders the equalizer glyph cluster (VU-meter-style bars ▁▂▃…█).
 * `elapsed` = ms since thinking started. Returns an already-colored string.
 */
function renderThinkingGlyphs(elapsed: number, c: AnimColors): string {
  const bars = [..."▁▂▃▄▅▆▇█"];
  let out = "";
  for (let i = 0; i < 5; i++) {
    const t = (Math.sin(elapsed / 150 + i * 0.9) + 1) / 2; // 0..1, phase-shifted
    const lvl = Math.round(t * (bars.length - 1));
    // height (lvl*6) + global pulse that makes the whole bar breathe
    out += c.shade(bars[lvl], lvl * 6 + c.pulseOffset);
  }
  return out;
}

// ── Custom editor ─────────────────────────────────────────

interface EditorContext {
  pi: ExtensionAPI;
  ctx: Record<string, any>;
  config: InputRevampConfig;
}

/** Read-only context passed to every element renderer. */
interface ElementRenderEnv {
  // colour ANSI codes
  accentAnsi: string;
  warningAnsi: string;
  successAnsi: string;
  errorAnsi: string;
  syntaxNumberAnsi: string;
  syntaxCommentAnsi: string;
  dimAnsi: string;
  // theme helpers
  thm: { fg: (k: string, s: string) => string; getFgAnsi: (k: string) => string };
  // session data
  ctx: Record<string, any>;
  pi: ExtensionAPI;
  metrics: ReturnType<typeof computeSessionMetrics>;
  sessionElapsed: number;
  toolCount: number;
  tokEstimate: number;
  turnInfo: { turnNum: number; turnDuration: string } | null;
  contextUsage: { percent: number | null; tokens: number | null; contextWindow: number | null };
  lastCompletedTurn: { turnNum: number; cost: number; output: number; cacheRead: number; input: number; duration: string } | null;
  metricUpdateCount: number;
}

/**
 * Editor that frames itself with a rounded rectangle ╭─╮│╰─╯, with fully
 * configurable info elements in all four corners and a π prompt character on
 * the first content line.
 *
 * The render is built from scratch via layoutText() for full control over the
 * spacing around the π.
 */
class NerismaInputEditor extends CustomEditor {
  private ext: EditorContext;
  private config: InputRevampConfig;
  private _thinkingTimer: ReturnType<typeof setInterval> | undefined;
  private _inputTimer: ReturnType<typeof setInterval> | undefined;
  private _wasThinking: boolean = false;
  private _wasPulsing: boolean = false;
  private _animStart: number = 0;
  private _lastInputText: string = "";
  /** Recent typing events (timestamp + number of characters added) to estimate WPM. */
  private _keyEvents: { t: number; n: number }[] = [];
  /** Smoothed typing intensity 0..1 (0 = accent, 1 = white). */
  private _typeIntensity: number = 0;
  /** Timestamp of the last keystroke (drives the fast fall once idle). */
  private _lastKeyTime: number = 0;
  /** Metrics-pulse intensity 0..1 (triggered on turn change). */
  private _metricPulse: number = 0;
  /** Signature of the last metrics value (change detection). */
  private _lastMetricsSig: string = "";
  /** Metrics-pulse decay timer. */
  private _metricTimer: ReturnType<typeof setInterval> | undefined;
  /** Border pulse on message submit (detected via non-empty text → empty). */
  private _submitPulse: number = 0;
  /** Submit-pulse decay timer. */
  private _submitTimer: ReturnType<typeof setInterval> | undefined;
  /** Pulse of the ~X tok counter when it updates. */
  private _tokPulse: number = 0;
  /** ~tok pulse decay timer. */
  private _tokTimer: ReturnType<typeof setInterval> | undefined;
  /** Last tokEstimate value for change detection. */
  private _lastTokValue: number = -1;
  /** Metrics update counter (shown in parentheses after T). */
  private _metricUpdateCount: number = 0;
  /** Previous serialized value per element ID — used to detect changes for per-element pulse.
   *  Each ElementId carries its own metric (e.g. session-cost vs turn-cost are distinct ids),
   *  so the same value is produced wherever the id is placed and keying by id can't collide. */
  private _prevElementValues = new Map<ElementId, string>();
  /** Element IDs currently mid-pulse (decay not finished yet). */
  private _pulsingElements = new Set<ElementId>();
  /** Cache of the last completed turn (shown while the current turn has no reply yet). */
  private _lastCompletedTurn: {
    turnNum: number;
    cost: number;
    output: number;
    cacheRead: number;
    input: number;
    duration: string;
  } | null = null;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    ext: EditorContext,
  ) {
    // paddingX at 0 keeps full control over spacing
    super(tui, theme, keybindings, { paddingX: 0 });
    this.ext = ext;
    this.config = ext.config;
  }

  dispose() {
    this._stopThinkingAnimation();
    this._stopInputAnimation();
    this._stopMetricAnimation();
    this._stopSubmitAnimation();
    this._stopTokAnimation();
  }

  private _startThinkingAnimation() {
    if (this._thinkingTimer) return;
    this._animStart = Date.now();
    this._thinkingTimer = setInterval(() => {
      try { this.tui.requestRender(); } catch { /* editor may be detached */ }
    }, 50);
  }

  private _stopThinkingAnimation() {
    if (this._thinkingTimer) {
      clearInterval(this._thinkingTimer);
      this._thinkingTimer = undefined;
    }
  }

  private _startInputAnimation() {
    if (this._inputTimer) return;
    this._inputTimer = setInterval(() => {
      try { this.tui.requestRender(); } catch {}
    }, 50);
  }

  private _stopInputAnimation() {
    if (this._inputTimer) {
      clearInterval(this._inputTimer);
      this._inputTimer = undefined;
    }
  }

  private _stopMetricAnimation() {
    if (this._metricTimer) {
      clearInterval(this._metricTimer);
      this._metricTimer = undefined;
    }
  }

  private _stopSubmitAnimation() {
    if (this._submitTimer) {
      clearInterval(this._submitTimer);
      this._submitTimer = undefined;
    }
  }

  private _stopTokAnimation() {
    if (this._tokTimer) {
      clearInterval(this._tokTimer);
      this._tokTimer = undefined;
    }
  }

  /**
   * Builds a text fragment for a single element ID, or returns null if the
   * data is not available.
   *
   * @returns the display text, its colour ANSI code, and an optional skipPulse
   *          flag (for elements that manage their own pulse, like `tok`).
   */
  private _renderElement(
    id: ElementId,
    env: ElementRenderEnv,
  ): { text: string; ansi: string; skipPulse?: boolean } | null {
    const { accentAnsi, warningAnsi, successAnsi, errorAnsi, syntaxNumberAnsi, syntaxCommentAnsi,
      dimAnsi, thm, ctx, pi, metrics, sessionElapsed, toolCount, tokEstimate,
      turnInfo, contextUsage, lastCompletedTurn, metricUpdateCount } = env;

    switch (id) {
      case "agent": {
        const agent = process.env.PI_ACTIVE_AGENT;
        if (!agent) return null;
        return { text: agent, ansi: accentAnsi };
      }
      case "model": {
        const model = ctx.model as { provider?: string; id?: string } | undefined;
        if (!model?.provider || !model?.id) return null;
        return { text: `${model.provider}/${model.id}`, ansi: accentAnsi };
      }
      case "thinking-level": {
        try {
          const level = pi.getThinkingLevel();
          if (!level || level === "off") return null;
          return { text: level, ansi: thm.getFgAnsi("syntaxFunction") };
        } catch {
          return null;
        }
      }
      case "cwd": {
        const cwd = ctx.cwd as string | undefined;
        if (!cwd) return null;
        return { text: formatCwd(cwd), ansi: thm.getFgAnsi("muted") };
      }
      case "duration": {
        if (sessionElapsed <= 0) return null;
        return { text: formatDuration(sessionElapsed), ansi: dimAnsi };
      }
      case "tools": {
        return { text: `${toolCount} tools`, ansi: thm.getFgAnsi("muted") };
      }
      case "tok": {
        if (tokEstimate <= 0) return null;
        const tokStr = `~${tokEstimate} tok`;
        const tp = this._tokPulse;
        if (this.config.animations.tokPulse && tp > 0.001) {
          return { text: lerpToWhite(syntaxCommentAnsi, Math.min(1, tp), tokStr), ansi: "", skipPulse: true };
        }
        return { text: tokStr, ansi: syntaxCommentAnsi };
      }
      case "session-label": {
        return { text: "SESSION", ansi: accentAnsi };
      }
      case "ctx-percent": {
        if (contextUsage.percent === null) return null;
        return { text: `${contextUsage.percent.toFixed(1)}%`, ansi: dimAnsi };
      }
      case "ctx-tokens": {
        if (contextUsage.tokens === null) return null;
        return { text: formatTokens(contextUsage.tokens), ansi: dimAnsi };
      }
      case "ctx-tokens-max": {
        if (contextUsage.contextWindow === null) return null;
        return { text: formatTokens(contextUsage.contextWindow), ansi: dimAnsi };
      }
      case "ctx-tokens-full": {
        if (contextUsage.tokens === null || contextUsage.contextWindow === null) return null;
        return { text: `${formatTokens(contextUsage.tokens)}/${formatTokens(contextUsage.contextWindow)}`, ansi: dimAnsi };
      }
      case "session-cost": {
        const c = metrics?.cost ?? 0;
        if (c <= 0) return null;
        return { text: `${c.toFixed(3)}$`, ansi: warningAnsi };
      }
      case "session-out": {
        const o = metrics?.output ?? 0;
        if (o <= 0) return null;
        return { text: `OUT ${formatTokens(o)}`, ansi: syntaxNumberAnsi };
      }
      case "session-hit": {
        const h = metrics?.cacheRead ?? 0;
        if (h <= 0) return null;
        return { text: `HIT ${formatTokens(h)}`, ansi: successAnsi };
      }
      case "session-miss": {
        const m = metrics?.input ?? 0;
        if (m <= 0) return null;
        return { text: `MISS ${formatTokens(m)}`, ansi: errorAnsi };
      }
      case "turn-cost": {
        const c = lastCompletedTurn?.cost ?? 0;
        if (c <= 0) return null;
        return { text: `${c.toFixed(3)}$`, ansi: warningAnsi };
      }
      case "turn-out": {
        const o = lastCompletedTurn?.output ?? 0;
        if (o <= 0) return null;
        return { text: `OUT ${formatTokens(o)}`, ansi: syntaxNumberAnsi };
      }
      case "turn-hit": {
        const h = lastCompletedTurn?.cacheRead ?? 0;
        if (h <= 0) return null;
        return { text: `HIT ${formatTokens(h)}`, ansi: successAnsi };
      }
      case "turn-miss": {
        const m = lastCompletedTurn?.input ?? 0;
        if (m <= 0) return null;
        return { text: `MISS ${formatTokens(m)}`, ansi: errorAnsi };
      }
      case "turn": {
        if (!turnInfo || turnInfo.turnNum <= 0) return null;
        return { text: `T${turnInfo.turnNum} (${metricUpdateCount})`, ansi: accentAnsi };
      }
      case "turn-duration": {
        if (!turnInfo || !turnInfo.turnDuration) return null;
        return { text: turnInfo.turnDuration, ansi: dimAnsi };
      }
      default:
        return null;
    }
  }

  /**
   * Builds a quadrant text from a list of element IDs.
   */
  private _buildQuadrant(
    elementIds: ElementId[],
    env: ElementRenderEnv,
    pulsedTextFn: (ansi: string, text: string, curve?: number) => string,
    separator: string = " · ",
  ): string {
    const parts: string[] = [];
    const sepDim = `${env.dimAnsi}${separator}\x1b[39m`;

    for (const id of elementIds) {
      const result = this._renderElement(id, env);
      if (!result) continue;

      if (result.skipPulse) {
        // Element manages its own pulse (e.g. tok uses _tokPulse)
        parts.push(result.text);
      } else {
        const key = `${result.ansi}|${result.text}`;
        const prev = this._prevElementValues.get(id);
        const changed = prev !== key;
        this._prevElementValues.set(id, key);
        if (changed) {
          this._pulsingElements.add(id);
        }
        if (this._pulsingElements.has(id)) {
          parts.push(pulsedTextFn(result.ansi, result.text));
          if (this._metricPulse < 0.01) {
            this._pulsingElements.delete(id);
          }
        } else {
          parts.push(`${result.ansi}${result.text}\x1b[39m`);
        }
      }
    }

    return parts.join(sepDim);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(2, width - 2);

    const { pi, ctx } = this.ext;
    const thm = ctx.ui.theme;

    // ── Border animation while thinking ────────────────
    const isThinking = !ctx.isIdle();
    if (isThinking && !this._wasThinking) {
      this._startThinkingAnimation();
    } else if (!isThinking && this._wasThinking) {
      this._stopThinkingAnimation();
      try { this.tui.requestRender(); } catch {}
    }
    this._wasThinking = isThinking;

    const now = Date.now();
    const accentAnsi = thm.getFgAnsi("accent");
    const warningAnsi = thm.getFgAnsi("warning");
    const successAnsi = thm.getFgAnsi("success");
    const errorAnsi = thm.getFgAnsi("error");
    const syntaxNumberAnsi = thm.getFgAnsi("syntaxNumber");
    const syntaxCommentAnsi = thm.getFgAnsi("syntaxComment");
    const dimAnsi = thm.getFgAnsi("dim");

    const accent = (s: string) => thm.fg("accent", s); // used by borderColorFn fallback

    // ── Typing speed → bar whitening (INDEPENDENT of thinking) ──
    const configAnim = this.config.animations;
    const currentText = this.getText();
    if (currentText !== this._lastInputText) {
      const delta = currentText.length - this._lastInputText.length;
      // Submit detection: non-empty text → empty (message submitted or clear all).
      if (configAnim.submitFlash && this._lastInputText !== "" && currentText === "") {
        this._submitPulse = 1.0;
        if (!this._submitTimer) {
          this._submitTimer = setInterval(() => {
            this._submitPulse *= METRIC_RELEASE;
            if (this._submitPulse < 0.01) {
              this._submitPulse = 0;
              this._stopSubmitAnimation();
            }
            try { this.tui.requestRender(); } catch {}
          }, 16);
        }
      }
      this._lastInputText = currentText;
      if (delta !== 0) {
        this._keyEvents.push({ t: now, n: Math.min(Math.abs(delta), TYPING_DELTA_CAP) });
        this._lastKeyTime = now;
      }
    }

    let borderT = 0;
    if (configAnim.typingPulse) {
      this._keyEvents = this._keyEvents.filter((e) => now - e.t < TYPING_WINDOW_MS);
      const charsInWindow = this._keyEvents.reduce((s, e) => s + e.n, 0);
      const wpm = (charsInWindow / 5) * (60000 / TYPING_WINDOW_MS);
      const targetIntensity = Math.max(0, Math.min(TYPING_MAX, wpm / TYPING_WHITE_WPM));
      if (now - this._lastKeyTime > TYPING_IDLE_MS) {
        this._typeIntensity *= TYPING_RELEASE;
      } else {
        this._typeIntensity += (targetIntensity - this._typeIntensity) * TYPING_ATTACK;
      }
      if (this._typeIntensity < 0.01) this._typeIntensity = 0;

      const isPulsing = this._typeIntensity > 0 || this._keyEvents.length > 0;
      if (isPulsing && !this._wasPulsing) {
        this._startInputAnimation();
      } else if (!isPulsing && this._wasPulsing) {
        this._stopInputAnimation();
        try { this.tui.requestRender(); } catch {}
      }
      this._wasPulsing = isPulsing;

      borderT = this._typeIntensity > 0.001
        ? Math.max(0, Math.min(1, this._typeIntensity + Math.sin(now / 70) * 0.12 * this._typeIntensity))
        : 0;
    } else {
      this._typeIntensity = 0;
      this._keyEvents = [];
      if (this._wasPulsing) {
        this._stopInputAnimation();
        this._wasPulsing = false;
      }
    }

    // Submit pulse (only if enabled)
    const submitT = configAnim.submitFlash ? this._submitPulse : 0;
    borderT = Math.max(borderT, submitT);
    const borderColorFn = (s: string) => {
      if (borderT > 0.001) return lerpToWhite(accentAnsi, borderT, s);
      return accent(s);
    };
    // The π follows the border color EXACTLY (same function).
    const promptColorFn = borderColorFn;

    // ── Session metrics (single computation, shared by all quadrants) ──
    let entries: readonly any[] = [];
    let sessionElapsed = 0;
    let toolCount = 0;
    let tokEstimate = 0;
    let metrics: ReturnType<typeof computeSessionMetrics> = null;
    let hasAssistantResponse = false;
    let turnCount = 0;
    let sessionInfo: ReturnType<typeof computeSessionInfo> | null = null;
    let contextUsage: { percent: number | null; tokens: number | null; contextWindow: number | null } = {
      percent: null, tokens: null, contextWindow: null,
    };

    try {
      entries = ctx.sessionManager?.getEntries?.() ?? [];
      metrics = computeSessionMetrics(entries);
      const info = computeSessionInfo(entries);
      sessionInfo = info;
      hasAssistantResponse = metrics !== null && metrics.output > 0;
      turnCount = info.turnCount;
      sessionElapsed = info.sessionStartTs ? Math.round((Date.now() - info.sessionStartTs) / 1000) : 0;
      const wireTools = effectiveToolNames(pi);
      toolCount = wireTools.length;
      tokEstimate = estimateTokens(this.getText());
      const usage = ctx.getContextUsage();
      if (usage) {
        contextUsage = {
          percent: usage.percent ?? null,
          tokens: usage.tokens ?? null,
          contextWindow: usage.contextWindow ?? null,
        };
      }
    } catch {}

    // Metrics change detection → pulse toward white.
    if (configAnim.metricPulse && hasAssistantResponse) {
      const sig = `${turnCount}|${metrics!.cost}|${metrics!.output}`;
      if (sig !== this._lastMetricsSig) {
        this._lastMetricsSig = sig;
        this._metricUpdateCount++;
        this._metricPulse = 1.0;
        if (!this._metricTimer) {
          this._metricTimer = setInterval(() => {
            this._metricPulse *= METRIC_RELEASE;
            if (this._metricPulse < 0.01) {
              this._metricPulse = 0;
              this._pulsingElements.clear();
              this._stopMetricAnimation();
            }
            try { this.tui.requestRender(); } catch {}
          }, 16);
        }
      }
    } else if (!configAnim.metricPulse) {
      this._metricPulse = 0;
      this._pulsingElements.clear();
    }

    // ── Last turn tracking ──────────────────────────────
    const lastTurn = computeLastTurnMetrics(entries);
    if (hasAssistantResponse && lastTurn && sessionInfo) {
      const turnDuration = (() => {
        const luts = sessionInfo.lastPromptTs;
        if (!luts) return "";
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.type === "message" && e.message?.role === "assistant") {
            const ts = new Date(e.timestamp).getTime();
            if (!isNaN(ts)) return formatDuration(Math.round((ts - luts) / 1000));
          }
        }
        return "";
      })();
      this._lastCompletedTurn = {
        turnNum: turnCount > 0 ? turnCount : 0,
        cost: lastTurn.cost,
        output: lastTurn.output,
        cacheRead: lastTurn.cacheRead,
        input: lastTurn.input,
        duration: turnDuration,
      };
    }

    const displayTurn = this._lastCompletedTurn;
    const turnInfo = displayTurn
      ? { turnNum: displayTurn.turnNum, turnDuration: displayTurn.duration }
      : null;

    // Pulse ~X tok when it updates (only if enabled).
    if (configAnim.tokPulse && tokEstimate > 0) {
      if (tokEstimate !== this._lastTokValue) {
        this._lastTokValue = tokEstimate;
        this._tokPulse = 1.0;
        if (!this._tokTimer) {
          this._tokTimer = setInterval(() => {
            this._tokPulse *= METRIC_RELEASE;
            if (this._tokPulse < 0.01) {
              this._tokPulse = 0;
              this._stopTokAnimation();
            }
            try { this.tui.requestRender(); } catch {}
          }, 16);
        }
      }
    } else if (!configAnim.tokPulse) {
      this._tokPulse = 0;
    }

    // ── PulsedText wrapper for metric pulse ─────────────────
    // Applied per-element in _buildQuadrant only when the value just changed.
    const pulsedTextFinal = (ansi: string, text: string, curve: number = 1) => {
      const mp = configAnim.metricPulse ? this._metricPulse : 0;
      const intensity = Math.pow(mp, curve);
      return intensity > 0.001 ? lerpToWhite(ansi, intensity, text) : `${ansi}${text}\x1b[39m`;
    };

    // ── Thinking animation line ───────────────────────────
    const result: string[] = [];

    if (isThinking) {
      const elapsed = Date.now() - this._animStart;
      let expression: string;
      if (activeToolName) {
        expression = DEFAULT_TOOL_EXPRESSION;
      } else {
        expression = THINKING_EXPRESSIONS[Math.abs(Math.floor(elapsed / 2000)) % THINKING_EXPRESSIONS.length];
      }
      const thinkOffset = Math.round(Math.sin(now / 120) * 75);
      const thinkColor = (s: string) => shadeFgAnsi(accentAnsi, thinkOffset, s);
      const wordStr = ` ${thinkColor(expression)}`;
      const glyphs = renderThinkingGlyphs(elapsed, {
        shade: (s, amount) => shadeFgAnsi(accentAnsi, amount, s),
        pulseOffset: thinkOffset,
      });
      const animLine = ` ${glyphs}${wordStr}`;
      const animWidth = visibleWidth(animLine);
      const pad = Math.max(0, width - animWidth);
      result.push(animLine + " ".repeat(pad));
      result.push("");
    }

    // ── Build quadrant texts ────────────────────────────
    const layout = this.config.layout;
    const sep = " · ";
    const env: ElementRenderEnv = {
      accentAnsi, warningAnsi, successAnsi, errorAnsi,
      syntaxNumberAnsi, syntaxCommentAnsi, dimAnsi, thm,
      ctx, pi, metrics, sessionElapsed, toolCount, tokEstimate,
      turnInfo, contextUsage, lastCompletedTurn: this._lastCompletedTurn,
      metricUpdateCount: this._metricUpdateCount,
    };

    // Top border
    const topLeftText = this._buildQuadrant(layout.topLeft, env, pulsedTextFinal, sep);
    const topRightText = this._buildQuadrant(layout.topRight, env, pulsedTextFinal, sep);

    const leftStr = topLeftText.length > 0 ? ` ${topLeftText} ` : "";
    const rightStr = topRightText.length > 0 ? ` ${topRightText} ` : "";

    // Top line: ╭─...─╮
    result.push(fitRoundedBorder(leftStr, rightStr, width, borderColorFn, true));

    // ── Content: word-wrapping via layoutText() ─────────
    const promptChar = promptColorFn("π");
    const promptPrefix = ` ${promptChar} `;
    const promptWidth = visibleWidth(promptPrefix);
    const layoutWidth = Math.max(1, innerWidth - promptWidth);
    (this as any).lastWidth = layoutWidth;

    const layoutLines = (this as any).layoutText(layoutWidth);
    const maxTextWidth = innerWidth - promptWidth;

    for (let i = 0; i < layoutLines.length; i++) {
      const ll = layoutLines[i];
      let displayText = ll.text;
      let lineWidth = visibleWidth(ll.text);

      if (ll.hasCursor && ll.cursorPos !== undefined) {
        const before = displayText.slice(0, ll.cursorPos);
        const after = displayText.slice(ll.cursorPos);

        if (after.length > 0) {
          const segs = [...(this as any).segment(after, "grapheme")];
          const firstG = segs[0]?.segment || "";
          const rest = after.slice(firstG.length);
          displayText = before + `\x1b[7m${firstG}\x1b[0m` + rest;
        } else {
          displayText = before + "\x1b[7m \x1b[0m";
          lineWidth += 1;
        }
      }

      if (lineWidth > maxTextWidth) {
        displayText = truncateToWidth(displayText, maxTextWidth);
        lineWidth = maxTextWidth;
      }

      if (i === 0) {
        const finalWidth = promptWidth + lineWidth;
        const padding = Math.max(0, innerWidth - finalWidth);
        result.push(borderColorFn("│") + promptPrefix + displayText + " ".repeat(padding) + borderColorFn("│"));
      } else {
        const indent = " ".repeat(promptWidth);
        const finalWidth = promptWidth + lineWidth;
        const padding = Math.max(0, innerWidth - finalWidth);
        result.push(borderColorFn("│") + indent + displayText + " ".repeat(padding) + borderColorFn("│"));
      }
    }

    // ── Autocomplete (slash commands, @mentions, etc.) ───
    if ((this as any).autocompleteState && (this as any).autocompleteList) {
      const autoLines = (this as any).autocompleteList.render(innerWidth);
      for (const line of autoLines) {
        let displayLine = line;
        let lw = visibleWidth(line);
        if (lw > innerWidth) {
          displayLine = truncateToWidth(line, innerWidth);
          lw = innerWidth;
        }
        const padding = " ".repeat(Math.max(0, innerWidth - lw));
        result.push(borderColorFn("│") + displayLine + padding + borderColorFn("│"));
      }
    }

    // ── Bottom quadrants ────────────────────────────────
    // Same env as the top: each metric element (session-* / turn-*) carries its
    // own scope, so the quadrant it lands in no longer changes what it reports.
    const bottomLeftText = this._buildQuadrant(layout.bottomLeft, env, pulsedTextFinal, sep);
    const bottomRightText = this._buildQuadrant(layout.bottomRight, env, pulsedTextFinal, sep);

    const bottomLeftStr = bottomLeftText.length > 0 ? ` ${bottomLeftText} ` : "";
    const bottomRightStr = bottomRightText.length > 0 ? ` ${bottomRightText} ` : "";

    // Bottom line: ╰─...─╯
    // fitRoundedBorder puts left on the left and right on the right.
    // The bottom-left text goes to the left side of the bottom border.
    result.push(fitRoundedBorder(bottomLeftStr, bottomRightStr, width, borderColorFn, false));

    return result;
  }
}

// ── Extension entry point ─────────────────────────────────

export default function (pi: ExtensionAPI): void {
  let registered = false;
  const config = loadConfig();

  // Capture (by reference) the tools array packed into each provider request,
  // so the UI can report exactly what was sent.
  pi.on("before_provider_request", (event) => {
    lastWirePayloadTools = findToolsArray(event.payload);
  });

  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    registered = true;

    ctx.ui.setWorkingVisible(false);

    // Footer fully hidden.
    ctx.ui.setFooter(() => ({
      render() { return []; },
      invalidate() {},
    }));

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      return new NerismaInputEditor(tui, theme, keybindings, { pi, ctx, config });
    });
  });

  // Track the running tool for the animated expressions.
  pi.on("tool_execution_start", (event) => {
    activeToolName = event.toolName;
  });

  pi.on("tool_execution_end", () => {
    activeToolName = null;
  });
}
