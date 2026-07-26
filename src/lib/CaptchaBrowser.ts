import { resolve } from 'node:path';
import { launchContext, launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import pino from 'pino';
import yn from 'yn';
import { sleep } from '@/lib/utils';

const logger = pino();

export interface BrowserGenerateInput {
  /** Lyrics for the "Lyrics editor" textbox. */
  prompt: string;
  /** Style tags for the styles textarea; skipped when absent. */
  tags?: string;
  /** Parsed SUNO_COOKIE jar. Undefined values are skipped, not stringified. */
  cookies: Record<string, string | undefined>;
  /** Current Clerk JWT; becomes the `__session` cookie. */
  sessionToken: string;
  /** Compared against the browser's real UA for drift only. Never sent as an override. */
  expectedUserAgent?: string;
}

// --- suno.com/create selectors (captured live 2026-07-23) -----------------------------------
const TABLIST_SEL = 'span[role="tablist"]';
const ADVANCED_TAB_SEL = 'button[role="tab"][aria-label="Advanced"]';
const LYRICS_SEL = 'div[role="textbox"][aria-label="Lyrics editor"]';
const STYLES_SEL = '[data-testid="create-form-styles-wrapper"] textarea';
const CREATE_BUTTON_SEL = 'button[aria-label="Create song"]';

// --- first-run onboarding coach marks ------------------------------------------------------
/**
 * Suno's onboarding cards (observed: "Create your own lyricist"), each closed by a "Got it" control.
 *
 * Matched by TEXT, not by tag. Playwright's `text="…"` engine selects the *smallest* element whose
 * text is exactly this, so it resolves whether Suno renders a `<button>`, a `<span>` inside one, or
 * a `<div role="button">` — and a click on an inner node bubbles to the handler either way. The
 * first attempt at this used `button:has-text("Got it")`, which assumes the tag and matches nothing
 * if the control is not literally a `<button>`.
 *
 * Confirmed live 2026-07-26: three elements carry that exact trimmed text, and the smallest is a
 * childless `<span>` (35x24) nested inside the button. So the tag assumption really was wrong, `text=`
 * resolves to the span, and a humanized click on it dismissed the card.
 */
const ONBOARDING_DISMISS_SEL = 'text="Got it"';
/** A tour shows its cards one at a time; bounded so a mis-detection cannot spin. */
const ONBOARDING_MAX_CARDS = 4;
/** Wait for a card that mounts on its own after the Advanced tab switch, animation included. */
const ONBOARDING_LOAD_TIMEOUT = 4000;
/** Opportunistic re-check before a click a late card could intercept. */
const ONBOARDING_RECHECK_TIMEOUT = 500;
/**
 * Re-check AFTER clicking a field, which is the sweep that matters.
 *
 * Observed live: the card is mounted *in reaction to* the field being clicked — the lyrics editor
 * is filled, the styles textarea is clicked, and only then does "Create your own lyricist" appear.
 * A sweep that runs only before the click therefore always finds nothing, and the fill then types
 * into whatever the card moved focus to. Long enough to cover the mount animation.
 */
const ONBOARDING_POSTCLICK_TIMEOUT = 1200;

// --- form fill -----------------------------------------------------------------------------
/** Attempts per field: enough that two separate cards can each cost one and the fill still lands. */
const FILL_ATTEMPTS = 3;
/**
 * Characters typed between focus re-checks.
 *
 * A card that mounts mid-fill takes focus, and the remainder of the text would otherwise be typed
 * into whatever took it — style tags appended to the lyrics, say, which no read-back of the styles
 * field would ever notice. Chunking bounds the damage to one chunk. The pauses it introduces read
 * as ordinary typist pauses, not as a tell.
 */
const TYPE_CHUNK = 40;

// --- Turnstile -----------------------------------------------------------------------------
/**
 * The modal host Suno mounts over the create page.
 *
 * Its removal is NOT the success signal, despite how it reads. Measured 2026-07-26 against a real
 * accepted challenge (widget `65lzr`): after the press was accepted and the generation submitted, the
 * host was still in the DOM, still `300x71`, and the challenge frame was still attached — it had merely
 * been RELOCATED to `0,0`. So this selector is the loop's entry condition and nothing more. Success is
 * TURNSTILE_TOKEN_SEL; see readTokenLength().
 */
const TURNSTILE_HOST = '#generation-turnstile-container';
/**
 * Cloudflare's verdict token — the only trustworthy success signal.
 *
 * Turnstile writes its result into this hidden input, and Suno reads it from there. Measured on the
 * accepted challenge above: `valueLen: 773` once the press passed, absent/empty before. This replaces
 * host-teardown detection, which reported failure on a challenge that had actually succeeded.
 *
 * Compared against a BASELINE taken at loop entry rather than merely tested non-empty, so a token left
 * over from an earlier solve on the same page can never be read as this challenge passing.
 *
 * Only ever the LENGTH is read or logged. The token is a bearer credential.
 */
const TURNSTILE_TOKEN_SEL = 'input[name="cf-turnstile-response"]';
/**
 * Frame-URL marker for a challenge that expired before anyone pressed it.
 *
 * Cloudflare names this state itself: the path segment before `/normal` goes from `new` to
 * `auto_timeout`. Observed live after the widget sat ~3 minutes untouched — the operator sees it change
 * colour and then vanish. The widget is unpressable from that point on; only a fresh one can be solved.
 */
const TURNSTILE_DEAD_FRAME_STATE = '/auto_timeout/';
/**
 * Smallest box that can plausibly BE the widget, in px.
 *
 * An expired widget does not detach — it collapses. Measured on the `auto_timeout` widget: the host went
 * to `0x0` while the iframe reported `1x1`, which sailed straight through the old
 * `width === 0 || height === 0` guard and produced an aim point of `(3, -0.9)` — off-viewport. Anything
 * this small is a corpse, not a control.
 */
const TURNSTILE_MIN_WIDGET: readonly [number, number] = [40, 20];
/** Matches a challenge frame URL, e.g. `…/turnstile/f/av0/rch/zms4x/<sitekey>/…`. */
const TURNSTILE_FRAME_URL = /challenges\.cloudflare\.com\/.*\/turnstile\//;
/** Captures the per-render widget id (`zms4x`) so a re-render is never taken for the old one. */
const TURNSTILE_WIDGET_ID = /\/rch\/([^/?#]+)/;
/** Tried first: when Cloudflare's challenge document exposes the input, it is the exact target. */
const TURNSTILE_CHECKBOX_SEL = 'input[type="checkbox"]';
/**
 * Fallback aim point: an inset from the widget iframe's LEFT edge, vertically centred.
 *
 * Needed because the challenge document is often unreadable — measured against a live widget, the
 * frame reports `title: "Checking your Browser…"`, zero body children and zero checkboxes, so
 * TURNSTILE_CHECKBOX_SEL matches nothing and there is no element to aim at. Without this fallback the
 * round concludes "nothing clickable" and never presses anything, which is exactly how a required
 * challenge turns into a two-minute hang.
 *
 * 24px lands on the checkbox or on its label, which is part of the same control. The widget is
 * 300x65 in the `normal` layout (measured), so this is well clear of the Privacy/Help links at the
 * bottom right. The inset itself is taken from the operator's screenshot and is UNVERIFIED — the
 * inner layout cannot be measured from an engine Cloudflare refuses to draw the widget for.
 */
const TURNSTILE_CHECKBOX_INSET_X = 24;
/** How long Suno may take to mount the modal after the Create click. */
const TURNSTILE_MODAL_TIMEOUT = 12000;
/** Distinct widget renders to work through. The operator reports it appearing several times. */
const TURNSTILE_MAX_WIDGETS = 6;
/** Presses on ONE render before giving up on it: a rejected click re-arms the SAME widget id. */
const TURNSTILE_CLICKS_PER_WIDGET = 2;
/** Per-press wait for the modal to be torn down or the widget to re-render. */
const TURNSTILE_SETTLE_TIMEOUT = 12000;
/** Worst-case wall time the captcha loop can consume, added to the API response timeout. */
const TURNSTILE_BUDGET = 90000;
/**
 * Spread applied to the aim point, in px. Two presses must never share a pixel.
 *
 * Not cosmetic. `humanMove()` returns immediately when the distance is under 1px, so a second press
 * on an unchanged aim point would be a bare `down`/`up` with no approach path at all — two clicks on
 * one pixel with zero intervening motion, which is a signature no hand produces. ±3px also stays well
 * inside the checkbox at a 24px inset on a 300x65 widget, so it does not put the fallback route at
 * risk; if anything it makes the unverified inset marginally more forgiving.
 */
const TURNSTILE_AIM_JITTER = 3;
/**
 * Dwell before a press, in milliseconds.
 *
 * Turnstile scores how long the visitor has been on the page and how the interaction is paced. The
 * press used to fire as soon as the widget had a measurable box, roughly half a second after it
 * mounted. A human notices the checkbox, then reaches for it.
 */
const TURNSTILE_DWELL_MS: readonly [number, number] = [900, 2400];

// --- device identity -----------------------------------------------------------------------
/**
 * Stable device seed for this deployment.
 *
 * CloakBrowser's `getDefaultStealthArgs()` emits `--fingerprint=<random 10000-99999>` on every
 * launch, and that seed drives the binary's canvas, WebGL, audio and font noise. Left alone, one Suno
 * account presents a DIFFERENT device on every generation from the same IP — an unrecognized device
 * on a logged-in session, which is what Cloudflare answers by escalating to an interactive challenge
 * every time. Each seed is internally coherent; the inconsistency is across runs, and it is the
 * likeliest cause of the challenge loop this module used to try to click its way out of.
 *
 * `buildArgs()` dedups by flag name and lets a caller-supplied arg win over the stealth default, so
 * passing it here pins it. Change it only to deliberately become a different machine.
 */
const FINGERPRINT_SEED = process.env.BROWSER_FINGERPRINT_SEED || '48213';
/**
 * Where the browser profile lives between runs. On by default; `BROWSER_PROFILE_DIR=none` opts out.
 *
 * Without it every run is a first visit: the cookie-consent banner is asked again, Suno replays its
 * first-run onboarding tour (which is the entire reason dismissOnboarding() exists), and there is no
 * `__cf_bm` continuity or Turnstile client state to carry. A profile with no history also scores
 * lower on its own.
 *
 * It does NOT buy a replayable `cf_clearance`: Suno's Turnstile is application-level (their own
 * sitekey, token posted to the generate endpoint), not a Cloudflare edge managed challenge, so
 * passing it yields a token rather than a clearance cookie.
 *
 * Resolved against cwd rather than left relative, so the profile does not move if the process is ever
 * started from somewhere other than the project root. Safe only because serialize() already
 * guarantees one launch at a time — a `userDataDir` cannot be opened twice concurrently. That mutex
 * must therefore outlive any licence upgrade, for this reason as well as for the seat.
 *
 * First run against a new directory still sees the consent banner and the tour. Warm it once with
 * `node docs/fingerprint-tools/warm-profile.mjs`, which opens a headed browser for exactly that.
 */
const PROFILE_DIR =
  process.env.BROWSER_PROFILE_DIR === 'none'
    ? undefined
    : resolve(process.env.BROWSER_PROFILE_DIR || './input/browser-profile');

const GENERATE_RESPONSE_PATH = '/api/generate/v2-web/';

/**
 * Backoff between launch attempts, in seconds. See launchWithRetry() — CloakBrowser's free tier
 * allows ONE concurrent session and its lease can outlive the process that held it, so a relaunch
 * shortly after a close is denied. Measured: a denial clears within roughly a minute of idle.
 */
const LAUNCH_RETRY_BACKOFF = [5, 20, 45];

/**
 * CloakBrowser's free tier allows one concurrent session, so two simultaneous /api/generate
 * calls on the captcha path must not both launch a browser. The chain is deliberately never left
 * rejected — a failed generation must not wedge the queue for every later request.
 */
let launchQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = launchQueue.then(fn, fn);
  launchQueue = run.catch(() => {});
  return run;
}

/** Identity of a rendered widget. Falls back to the whole URL if Cloudflare changes the shape. */
function widgetKey(url: string): string {
  return TURNSTILE_WIDGET_ID.exec(url)?.[1] ?? url;
}

/** Uniform random in [min, max). */
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Sub-second pause. utils' `sleep()` quantises to whole seconds (and can therefore return 0 for a
 * sub-second range) and logs a line per call, neither of which suits a per-press dwell.
 */
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** ±TURNSTILE_AIM_JITTER px, so a retry never reuses the previous pixel. See that constant. */
const jitter = (v: number) => v + rand(-TURNSTILE_AIM_JITTER, TURNSTILE_AIM_JITTER);

/**
 * Launches CloakBrowser's patched Chromium.
 *
 * Four deliberate omissions versus the old rebrowser launch:
 *   - no `args`: `--disable-web-security` is itself a tell (real Chrome never runs with it) and
 *     only existed to collapse site isolation for the old hand-rolled solver. CloakBrowser ships
 *     its own tuned `getDefaultStealthArgs()` plus `IGNORE_DEFAULT_ARGS`.
 *   - no `viewport`: CloakBrowser version-gates this, because a maximized headless window with a
 *     1280x720 CDP viewport yields `outerWidth < innerWidth`, itself a bot tell.
 *   - no `userAgent`: an override routes through CDP `Emulation.setUserAgentOverride`. The binary
 *     reports its real version natively; drift against the HTTP layer is detected instead, see
 *     checkUserAgentDrift().
 *   - no `channel`: CloakBrowser is Chromium-only.
 *
 * `humanize: true` is what makes the Turnstile click survive scrutiny — see clickTurnstileIfPresent().
 *
 * Three things ARE passed deliberately, all of them consistency fixes:
 *   - `args: ['--fingerprint=…']` pins the device across runs. See FINGERPRINT_SEED.
 *   - `geoip`, but only when it is safe (see below), which is what spoofs the WebRTC IP to the
 *     proxy's exit IP. Without it, HTTP egresses through the proxy while WebRTC keeps advertising the
 *     real connection — a contradiction no amount of behavioural polish covers for.
 *   - a persistent profile when BROWSER_PROFILE_DIR is set. See PROFILE_DIR.
 */
async function launchStealthContext(): Promise<BrowserContext> {
  // A bare language tag is not a shape any default Chrome install produces: measured, `en` yields
  // `Accept-Language: en` and `navigator.languages ["en"]`, where a real Chrome yields
  // `en-US,en;q=0.9` and `["en-US","en"]`. See docs/fingerprint-tools/verify-locale-header.mjs. So a
  // region-qualified default, and a warning rather than a silent pass-through for anything else.
  const locale = process.env.BROWSER_LOCALE || 'en-GB';
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) {
    logger.warn(
      `BROWSER_LOCALE="${locale}" has no region, so the browser will report a language string ` +
        'no default Chrome emits (e.g. `Accept-Language: en` instead of `en-US,en;q=0.9`) — an ' +
        'inconsistency against its own Chrome identity. Use a form like en-GB or en-US.'
    );
  }
  const timezone = process.env.BROWSER_TIMEZONE || undefined;
  const proxy = process.env.BROWSER_PROXY || undefined;

  // geoip is safe ONLY with both timezone and locale explicit: maybeResolveGeoip() then returns early
  // and does nothing but resolve the proxy's exit IP for WebRTC. Without them it calls
  // resolveProxyGeo(), which THROWS unless the optional `mmdb-lib` peer dep is installed and also
  // downloads a ~70MB GeoLite2 database on first use — neither belongs in the middle of a generation.
  // With no proxy there is no exit IP to resolve, so it would be a pointless third-party call.
  const geoip = !!proxy && !!timezone;
  if (proxy && !geoip) {
    logger.warn(
      'BROWSER_PROXY is set but BROWSER_TIMEZONE is not, so geoip stays off and WebRTC will keep ' +
        'reporting the real local IP while HTTP egresses through the proxy. Set BROWSER_TIMEZONE ' +
        "to the proxy's zone to close that gap (it needs no extra dependency)."
    );
  }

  const options = {
    headless: yn(process.env.BROWSER_HEADLESS, { default: false }),
    humanize: true,
    // This path only runs when a captcha is ALREADY required, so a slower, more deliberate mouse and
    // keyboard costs latency that does not matter and buys signal that does. `careful` is also the
    // only preset with `idle_between_actions` enabled.
    humanPreset: process.env.BROWSER_HUMAN_PRESET === 'default' ? undefined : ('careful' as const),
    locale,
    timezone,
    proxy,
    geoip,
    args: [`--fingerprint=${FINGERPRINT_SEED}`]
  };

  if (!PROFILE_DIR) {
    logger.warn(
      'BROWSER_PROFILE_DIR=none, so this run gets a throwaway profile: the cookie banner and the ' +
        'onboarding tour will both appear again, and the device will have no history to be scored on.'
    );
    return await launchContext(options);
  }
  logger.info(`Reusing the browser profile at ${PROFILE_DIR}`);
  return await launchPersistentContext({ ...options, userDataDir: PROFILE_DIR });
}

/**
 * Launches, and proves the browser is actually alive before handing it back.
 *
 * The liveness probe is not paranoia. When the concurrent-session seat is already leased, the
 * binary exits during startup (observed exit code 76, ~250ms) but `launchContext()` still
 * RESOLVES — the failure only surfaces on the first real command, as
 * "Target page, context or browser has been closed". Probing here converts that into a retry
 * instead of an inexplicable mid-generation crash.
 *
 * The probe deliberately does TWO commands with a settle in between: the kill was observed to
 * arrive asynchronously, i.e. a first navigation can succeed and the browser still be gone a
 * moment later. Catching that here costs under a second and turns a mid-generation death into a
 * retry.
 *
 * @throws when every attempt is exhausted, with the seat limit named as the likely cause.
 */
async function launchWithRetry(): Promise<{ context: BrowserContext; page: Page }> {
  const attempts = LAUNCH_RETRY_BACKOFF.length + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let context: BrowserContext | undefined;
    try {
      context = await launchStealthContext();
      // A persistent context is launched with a page already open, so newPage() there would leave an
      // unused blank tab behind — and a second tab is itself slightly unusual. A non-persistent
      // context has no pages, so this falls through to newPage() as before.
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('about:blank', { timeout: 15000 });
      await sleep(1);
      await page.evaluate(() => 1);
      return { context, page };
    } catch (error) {
      lastError = error;
      await context?.close().catch(() => {});
      if (attempt === attempts) break;
      const wait = LAUNCH_RETRY_BACKOFF[attempt - 1];
      logger.warn(
        `CloakBrowser launch attempt ${attempt}/${attempts} failed (likely the one-session ` +
          `licence seat still being leased); retrying in ${wait}s`
      );
      await sleep(wait);
    }
  }

  throw new Error(
    `CloakBrowser failed to launch after ${attempts} attempts. The most common cause is the ` +
      `concurrent-session limit on the current licence (a stale lease can outlive the process ` +
      `that held it). Original error: ${(lastError as Error)?.message ?? lastError}`
  );
}

/**
 * Seeds the session JWT plus every cookie from SUNO_COOKIE onto `.suno.com`.
 * Raw cookie strings carry no domain, so an explicit `.suno.com` keeps them from becoming
 * host-only — the same reasoning as the curl jar seeding in SunoApi's constructor.
 */
async function seedCookies(context: BrowserContext, input: BrowserGenerateInput): Promise<void> {
  const sameSite = 'Lax' as const;
  const entries = [
    { name: '__session', value: input.sessionToken, domain: '.suno.com', path: '/', sameSite }
  ];
  for (const [name, value] of Object.entries(input.cookies)) {
    // The old code did `value + ''`, which turned a missing cookie into the literal "undefined".
    if (value === undefined) continue;
    entries.push({ name, value, domain: '.suno.com', path: '/', sameSite });
  }
  await context.addCookies(entries);
}

/**
 * Confirms CloakBrowser's behavioural layer is actually installed on this page.
 *
 * The Turnstile click depends entirely on `page.mouse.click` being the humanized implementation
 * (see clickTurnstileIfPresent()). If `humanize` ever silently fails to apply, the click degrades
 * to a bare CDP event — the exact signal this migration exists to remove — and the only symptom
 * would be Turnstile mysteriously never solving. Fail loudly in the log instead.
 */
function assertHumanized(page: Page): void {
  const humanized =
    page.mouse.click.toString().includes('humanClick') &&
    page.mouse.move.toString().includes('humanMove');
  if (humanized) return;
  logger.warn(
    'CloakBrowser humanize layer is NOT active on this page: page.mouse is unpatched, so the ' +
      'Turnstile click would be a bare CDP event. Check that launchContext received ' +
      'humanize: true and that the installed cloakbrowser build still patches page.mouse.'
  );
}

/**
 * Warns if the browser's real UA disagrees with what the curl-cffi transport claims.
 *
 * Compares the major version only, because that is what `impersonate: '<profile>'` has to agree
 * with. A difference is expected while the licensed binary is newer than the newest TLS profile
 * curl-cffi ships: each path stays internally consistent (browser UA matches the real browser;
 * transport UA matches its own JA3), and pinning the transport UA forward without a matching TLS
 * profile would be strictly worse. Logged so the divergence is never a surprise.
 */
async function checkUserAgentDrift(page: Page, expected?: string): Promise<void> {
  if (!expected) return;
  const actual = await page.evaluate(() => navigator.userAgent).catch(() => null);
  if (!actual) return;
  const major = (ua: string) => /Chrome\/(\d+)/.exec(ua)?.[1] ?? '?';
  if (major(actual) !== major(expected)) {
    logger.info(
      `Browser/transport version split: browser is Chrome/${major(actual)}, the curl-cffi ` +
        `transport presents Chrome/${major(expected)}. Each path is internally consistent; to ` +
        `align them pin the binary with CLOAKBROWSER_VERSION. Browser UA: ${actual}`
    );
  }
}

/**
 * Is Suno's challenge host mounted?
 *
 * Entry condition only. It does NOT go false on success — see TURNSTILE_HOST. Kept as a secondary
 * success signal because a teardown is still unambiguous when it does happen, but nothing depends on it.
 */
function modalPresent(page: Page): Promise<boolean> {
  return page.evaluate((sel) => !!document.querySelector(sel), TURNSTILE_HOST).catch(() => false);
}

/**
 * Length of Cloudflare's verdict token, or 0 when there is none.
 *
 * The LENGTH, never the value: the token is a bearer credential and this number is logged. A length is
 * all the loop needs, because it only ever asks "did this change from the baseline".
 */
function readTokenLength(page: Page): Promise<number> {
  return page
    .evaluate((sel) => {
      const input = document.querySelector(sel) as HTMLInputElement | null;
      return input && input.value ? input.value.length : 0;
    }, TURNSTILE_TOKEN_SEL)
    .catch(() => 0);
}

/** Has this challenge expired unpressed? Cloudflare says so in the frame URL — see the constant. */
function frameExpired(frame: Frame): boolean {
  return frame.url().includes(TURNSTILE_DEAD_FRAME_STATE);
}

/**
 * The attached challenge frame, if there is one.
 *
 * Frame enumeration is the only discovery route, and deliberately so. Cloudflare creates the widget
 * wrapper with `attachShadow({ mode: 'closed' })`, which nothing pierces — not Playwright's CSS
 * engine, not `>>>`, not `frameLocator()`. Measured against a live widget:
 * `#generation-turnstile-container iframe` matches ZERO elements while the host reports children.
 * But `page.frames()` is shadow-blind in both directions, so it sees the challenge frame however
 * deeply the <iframe> is buried, and it crosses process boundaries, so it keeps working with site
 * isolation in force.
 *
 * Do NOT try to reach the widget by patching `Element.prototype.attachShadow` to force the root
 * open: Cloudflare detects the patched prototype and blocks the challenge outright.
 */
function challengeFrame(page: Page): Frame | null {
  return page.frames().find((f) => TURNSTILE_FRAME_URL.test(f.url())) ?? null;
}

/**
 * Where to press for this widget, in MAIN-FRAME viewport coordinates.
 *
 * `boundingBox()` on an element inside a cross-origin iframe reports main-frame coordinates, which is
 * precisely what makes driving either target with the page mouse possible. Two routes:
 *
 *   1. **The checkbox element.** Exact, and used whenever Cloudflare's inner DOM exposes it.
 *   2. **The widget iframe's own box**, via `frame.frameElement()` — which resolves through the CDP
 *      frame tree rather than the DOM, so it returns the iframe even though no selector can reach it
 *      inside that closed shadow root (verified). Aim is then TURNSTILE_CHECKBOX_INSET_X from the
 *      left edge, vertically centred.
 *
 * Route 2 is not a nicety. Measured against a live widget, the challenge document reads as
 * "Checking your Browser…" with an empty body, so route 1 finds nothing — and without a fallback the
 * challenge is silently never pressed.
 *
 * @returns null only while the widget has no box at all: still mounting, or already torn down.
 */
async function aimPoint(frame: Frame): Promise<{ x: number; y: number; via: string } | null> {
  const checkbox = await frame
    .locator(TURNSTILE_CHECKBOX_SEL)
    .first()
    .boundingBox({ timeout: 2000 })
    .catch(() => null);
  if (checkbox && checkbox.width > 0 && checkbox.height > 0) {
    return {
      x: jitter(checkbox.x + checkbox.width / 2),
      y: jitter(checkbox.y + checkbox.height / 2),
      via: 'the checkbox element itself'
    };
  }

  const widget = await frame
    .frameElement()
    .then((el) => el.boundingBox())
    .catch(() => null);
  // Not `width === 0`: an expired widget collapses to 1x1 rather than to nothing, and 1x1 passed that
  // test and yielded an off-viewport aim of (3, -0.9). See TURNSTILE_MIN_WIDGET.
  if (!widget || widget.width < TURNSTILE_MIN_WIDGET[0] || widget.height < TURNSTILE_MIN_WIDGET[1]) {
    return null;
  }
  return {
    x: jitter(widget.x + Math.min(TURNSTILE_CHECKBOX_INSET_X, widget.width / 2)),
    y: jitter(widget.y + widget.height / 2),
    via:
      `the widget box (${Math.round(widget.width)}x${Math.round(widget.height)}), inset ` +
      `${TURNSTILE_CHECKBOX_INSET_X}px — the challenge document exposed no checkbox`
  };
}

/**
 * Waits for a token to appear, the widget to re-render or expire, the host to go, or time to run out.
 *
 * The token check comes FIRST because it is the only signal that means "accepted". Measured on the
 * accepted challenge: Cloudflare took ~5.5s from press to verdict, and the host never went away — so an
 * implementation that watched only the host reported `unchanged` for the full 12s on a challenge that had
 * already passed, then pressed a second time on an already-solved widget whose box had moved to the
 * corner of the screen.
 */
async function waitForOutcome(
  page: Page,
  key: string,
  baselineToken: number,
  timeout: number
): Promise<'solved' | 'rerendered' | 'expired' | 'unchanged'> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(0.5);
    if ((await readTokenLength(page)) > baselineToken) return 'solved';
    if (!(await modalPresent(page))) return 'solved';
    const frame = challengeFrame(page);
    if (!frame || widgetKey(frame.url()) !== key) return 'rerendered';
    if (frameExpired(frame)) return 'expired';
  }
  return 'unchanged';
}

/**
 * Works the Turnstile challenge Suno overlays on the create page until Cloudflare issues a token.
 *
 * Entry is driven by the MODAL and exit by the TOKEN, and the two must not be confused. Modal entry
 * matters in both directions: it does not conclude "auto-resolved" from a window in which the modal
 * simply had not mounted yet, and it keeps working when Cloudflare re-arms the challenge — the operator
 * reports it appearing several times in a row. Token exit matters because the host survives a successful
 * solve (see TURNSTILE_HOST): the earlier host-teardown exit reported failure on a challenge that had
 * passed, and then delivered a second press whose aim had moved to the corner of the viewport.
 *
 * Two guards bound it: TURNSTILE_CLICKS_PER_WIDGET presses on any single render (a rejected press
 * re-arms the SAME widget id, so counting distinct ids alone would never retry), and
 * TURNSTILE_MAX_WIDGETS distinct renders overall, inside a TURNSTILE_BUDGET wall clock.
 *
 * Presses go through the PAGE mouse, never `frame.click()`. CloakBrowser's humanize layer patches
 * frames from a depth-1 snapshot taken inside `patchPage()` and re-taken only by the patched
 * `page.goto()`; it installs no `frameattached` listener. The challenge iframe attaches *after* the
 * Create click with no navigation, so it is never patched and `frame.click()` on it would be a bare
 * CDP event. `page.mouse.click` is patched once and stays patched for the page's lifetime, so it
 * still delivers the full behavioural treatment: a Bezier approach path with wobble and overshoot, an
 * aim delay before pressing, and a realistic press-hold duration. Verified end to end by
 * docs/fingerprint-tools/verify-turnstile-click-path.mjs.
 *
 * Three things this function adds on top, because the raw mouse path gets none of them for free:
 * a dwell before each press (TURNSTILE_DWELL_MS), jitter on the aim point (TURNSTILE_AIM_JITTER), and
 * a deliberate reposition before a retry — without which a second press on an unchanged aim point
 * would carry no cursor movement at all. `page.mouse.click` never calls humanIdle(), unlike
 * `page.click(selector)`.
 *
 * Never throws — the caller treats the captcha step as optional and awaits the API response either
 * way.
 *
 * @returns how many presses were delivered.
 */
async function clickTurnstileIfPresent(page: Page): Promise<number> {
  const mounted = await page
    .waitForFunction((sel) => !!document.querySelector(sel), TURNSTILE_HOST, {
      timeout: TURNSTILE_MODAL_TIMEOUT
    })
    .then(() => true)
    .catch(() => false);
  if (!mounted) {
    logger.info('No Turnstile modal appeared — Suno accepted the create without a challenge');
    return 0;
  }
  logger.info('Turnstile modal is up — Suno is requiring a challenge');

  // Baseline, not a mere non-empty test: a token from an earlier solve on this page would otherwise read
  // as this challenge passing before a single press had been delivered. See TURNSTILE_TOKEN_SEL.
  const baselineToken = await readTokenLength(page);
  if (baselineToken > 0) {
    logger.info(
      `A Turnstile token from an earlier challenge is already present (${baselineToken} chars). ` +
        'Only a token longer or different from this baseline counts as this challenge passing.'
    );
  }

  const deadline = Date.now() + TURNSTILE_BUDGET;
  const pressesByWidget = new Map<string, number>();
  let presses = 0;

  while (Date.now() < deadline) {
    // Token first: the host does NOT go away on success, so checking it first would miss every pass.
    const token = await readTokenLength(page);
    if (token > baselineToken) {
      logger.info(
        `Turnstile passed — Cloudflare issued a token (${token} chars) after ${presses} press(es)`
      );
      return presses;
    }
    if (!(await modalPresent(page))) {
      logger.info(`Turnstile cleared — Suno tore the modal down after ${presses} press(es)`);
      return presses;
    }

    const frame = challengeFrame(page);
    if (!frame) {
      await sleep(0.5); // modal is up but the iframe has not attached yet
      continue;
    }

    // An expired widget cannot be pressed into passing, and it does not detach — it collapses in place,
    // so without this the loop would spend its whole budget pressing a corpse.
    if (frameExpired(frame)) {
      logger.warn(
        `Turnstile widget ${widgetKey(frame.url())} expired before it was solved (Cloudflare marked ` +
          'the frame auto_timeout). Nothing mounted a replacement, so this generation cannot be ' +
          'completed — the challenge has to be re-armed by clicking Create again. See §6 TODO 41.'
      );
      break;
    }

    const key = widgetKey(frame.url());
    const done = pressesByWidget.get(key) ?? 0;

    if (done === 0 && pressesByWidget.size >= TURNSTILE_MAX_WIDGETS) {
      // Say what a loop MEANS, rather than implying another press would have worked. A challenge that
      // re-arms after an accepted press is Cloudflare reporting a trust score too low to clear, and no
      // number of presses raises it. The causes this deployment controls are listed in the audit.
      logger.warn(
        `Cloudflare has re-challenged ${pressesByWidget.size} times without accepting. That is a ` +
          'trust-score refusal, not a missed click: the presses are landing and being rejected. ' +
          'Check, in order — is BROWSER_FINGERPRINT_SEED stable across runs (a new device every ' +
          'generation is scored as one), is BROWSER_PROFILE_DIR set (a profile with no history ' +
          'scores lower), and is the egress a datacenter IP (which caps the score on its own)? See ' +
          'docs/2026-07-26-turnstile-challenge-loop-audit.md. Stopping so the response wait can ' +
          'report the real outcome.'
      );
      break;
    }
    if (done >= TURNSTILE_CLICKS_PER_WIDGET) {
      logger.warn(
        `Turnstile widget ${key} did not clear after ${done} presses. Either this challenge cannot be ` +
          'passed by a checkbox, or the press is not landing on it — re-run with ' +
          'BROWSER_HEADLESS=false to watch where the cursor goes.'
      );
      break;
    }

    const aim = await aimPoint(frame);
    if (!aim) {
      logger.info(`Turnstile widget ${key} has no measurable box yet — letting it mount`);
      await sleep(1);
      continue;
    }

    if (done > 0) {
      // Park the cursor off-target first. humanMove() returns immediately under 1px of travel, so
      // without this the retry would be a motionless down/up on the pixel the cursor already sits on
      // — see TURNSTILE_AIM_JITTER. Failure is ignored: a missed reposition costs realism, not the
      // press.
      await page.mouse.move(aim.x + rand(60, 100), aim.y - rand(40, 70)).catch(() => {});
    }
    await pause(rand(TURNSTILE_DWELL_MS[0], TURNSTILE_DWELL_MS[1]));

    await page.mouse.click(aim.x, aim.y);
    pressesByWidget.set(key, done + 1);
    presses++;
    logger.info(
      `Pressed Turnstile widget ${key} (${done + 1}/${TURNSTILE_CLICKS_PER_WIDGET}) with the ` +
        `humanized page mouse at (${Math.round(aim.x)}, ${Math.round(aim.y)}), aimed from ${aim.via}`
    );

    const outcome = await waitForOutcome(page, key, baselineToken, TURNSTILE_SETTLE_TIMEOUT);
    if (outcome === 'rerendered') logger.info(`Cloudflare replaced widget ${key} — new challenge`);
    else if (outcome === 'expired') logger.info(`Widget ${key} expired while settling`);
    else if (outcome === 'unchanged') logger.info(`Widget ${key} has not resolved yet`);
    // 'solved' is reported by the token check at the top of the loop, which owns the single exit path.
  }

  // Judged on the TOKEN, not on the host. Asking `modalPresent()` here reported failure on every
  // successful challenge, because the host outlives the solve — see TURNSTILE_HOST.
  if ((await readTokenLength(page)) <= baselineToken) {
    logger.error(
      `Cloudflare issued no Turnstile token after ${presses} press(es) and ` +
        `${Math.round(TURNSTILE_BUDGET / 1000)}s. The generation will now almost certainly time out ` +
        'waiting for the API response.'
    );
  }
  return presses;
}

/**
 * Dismisses Suno's first-run onboarding cards by clicking their "Got it" button.
 *
 * NOT because the profile is fresh each run — it is not. PROFILE_DIR defaults to a PERSISTENT
 * ./input/browser-profile, and dismissing a card writes a flag into that profile's localStorage:
 * measured live 2026-07-26, closing "Create your own lyricist" added
 * `lyrics-onboarding-lyricist-tooltip-seen`. So a warm profile never replays the tour and every sweep
 * here is a no-op; only a FRESH profile directory sees the cards, exactly once (see PROFILE_DIR, which
 * says the same). Still worth keeping: warm-profile.mjs may never have been run, BROWSER_PROFILE_DIR
 * may be 'none', and Suno adds new cards whose flags this profile has not got.
 *
 * The trigger is interaction, not page load: the card appears when a form field is clicked, which is
 * why fillField() sweeps again *after* its click and treats a non-zero return as "focus has moved, aim
 * at the field again". Two details measured live, both load-bearing: clicking the styles textarea with
 * the lyrics editor still EMPTY was enough to mount the card, so a filled lyrics field is no part of
 * the trigger; and dismissing it left focus on the Advanced TAB rather than the field, which is
 * precisely why the re-click after a non-zero sweep cannot be skipped.
 *
 * The "Create your own lyricist" card mounts *over* the styles textarea, and nothing stops the fill
 * from clicking it by mistake: CloakBrowser 0.5.2 has
 * an overlay guard (`checkPointerEvents`) but it never fires, because it hands its hit-test
 * predicate to `locator.evaluate()` as a STRING, so the arrow function is never invoked, the call
 * returns `undefined`, and `if (!result || result.hit) return;` treats that as a pass. The click
 * therefore lands on whatever is topmost, silently, and the styles are typed into nothing — no
 * error to catch, which is why the card is dismissed up front instead of handled afterwards.
 * Measured in docs/fingerprint-tools/verify-onboarding-dismissal.mjs: covered field, click
 * resolves, press lands on the card, field left empty.
 *
 * The card OVERLAPS the Create button; it does not merely sit above it. Measured live 2026-07-26 at a
 * 2048x927 viewport: card at 284,525 320x320 (bottom 845) against Create at 264,779 418x48, so the
 * card's lower edge is 66px BELOW the button's top edge, and `document.elementFromPoint` at the
 * button's centre returns the CARD. Only its right third (x > 604) leaves the button exposed. An
 * earlier note here recorded a ~17px gap and warned that a slightly taller card would swallow the
 * Create click; that gap is stale and the swallowed click is now the default case, which is what makes
 * the sweep immediately before the Create click in generateSongViaBrowser() load-bearing rather than
 * belt-and-braces. It would present as a hang on the response wait, not as a failure. Note the card
 * wins the hit test with `z-index: auto` against the button wrapper's `z-index: 2` — stacking comes
 * from paint order here, so reading z-index to predict this would mislead.
 *
 * Clicked through the handle returned by the patched `page.waitForSelector`, which carries the
 * humanized `click()`. Using the handle rather than `page.click(selector)` keeps the click on the
 * element that was actually found, so a card auto-dismissing mid-call cannot stall on a selector
 * re-resolve.
 *
 * Never throws — a tour that fails to close is worth a warning, not a failed generation.
 *
 * @param timeout how long to wait for a card to appear before concluding there is none.
 * @returns how many cards were closed. Callers use a non-zero count as the signal to re-establish
 *          focus, because closing a card takes focus away from the field.
 */
async function dismissOnboarding(page: Page, timeout: number): Promise<number> {
  let dismissed = 0;

  for (let card = 1; card <= ONBOARDING_MAX_CARDS; card++) {
    const control = await page
      .waitForSelector(ONBOARDING_DISMISS_SEL, {
        state: 'visible',
        timeout: card === 1 ? timeout : ONBOARDING_RECHECK_TIMEOUT
      })
      .catch(() => null);
    if (!control) return dismissed;

    // Checked on the handle, not the selector: the tour can mount its next card immediately, and a
    // selector-level check would then be satisfied by the wrong element — or never satisfied.
    // 'hidden' is also true for a detached element, which is how these cards usually go away.
    const isGone = () =>
      control
        .waitForElementState('hidden', { timeout: 5000 })
        .then(() => true)
        .catch(() => false);

    await control.click({ timeout: 5000 }).catch(() => {});
    let gone = await isGone();

    if (!gone) {
      // Name whatever owns that point before falling back, so a recurring blocker is diagnosable
      // from the log rather than by another round of screenshots.
      const blocker = await control
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!at) return 'nothing — the control has no box at that point';
          if (at === el || el.contains(at) || at.contains(el)) return 'nothing — the control itself';
          const id = at.id ? `#${at.id}` : '';
          const cls =
            typeof at.className === 'string' && at.className.trim()
              ? `.${at.className.trim().split(/\s+/).join('.')}`
              : '';
          return `${at.tagName.toLowerCase()}${id}${cls}`;
        })
        .catch(() => 'unknown');

      logger.warn(
        `A real click did not close onboarding card ${card}; the point is owned by ${blocker}. ` +
          'Falling back to a direct DOM click.'
      );

      // Last resort, and deliberately untrusted: HTMLElement.click() dispatches straight at the
      // element, so no overlay can intercept it. Acceptable here precisely because the target is
      // Suno's own tour card, not a bot check — unlike the Turnstile click, which must stay
      // trusted and therefore never uses this path.
      await control.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
      gone = await isGone();
    }

    if (!gone) {
      logger.error(
        `Onboarding card ${card} would not close, even with a direct DOM click. The form fields ` +
          'underneath it are probably still covered, so this generation may fail to fill.'
      );
      return dismissed;
    }
    dismissed++;
    logger.info(`Dismissed Suno onboarding card ${card} ("Got it")`);
  }

  logger.warn(
    `Stopped dismissing onboarding cards after ${ONBOARDING_MAX_CARDS}; "${ONBOARDING_DISMISS_SEL}" ` +
      'keeps matching, so the selector may now be hitting something that is not a tour card'
  );
  return dismissed;
}

/**
 * Whitespace-insensitive form of a field's text, for comparing what was typed against what arrived.
 *
 * Whitespace is stripped rather than collapsed: the lyrics editor is a Lexical-style contenteditable
 * that puts each line in its own node, so `textContent` can join lines with no separator at all
 * ("line oneline two"), which a space-collapsing comparison would reject. Comparing the WHOLE text
 * this way also catches a fill that was truncated halfway — the signature of a card mounting
 * mid-type — which a short prefix probe would sail straight past.
 */
const squash = (s: string) => s.replace(/\s+/g, '');

/** Reads a field's text, whether it is a real input or a contenteditable editor. */
function readField(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
      ? el.value
      : (el.textContent ?? '');
  }, selector);
}

/**
 * Is the keyboard actually pointed at this field? `contains` covers a contenteditable whose inner
 * text node takes focus rather than the labelled element itself.
 */
function hasFocus(page: Page, selector: string): Promise<boolean> {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      const active = document.activeElement;
      return !!el && !!active && (active === el || el.contains(active));
    }, selector)
    .catch(() => false);
}

/** Names whatever holds focus instead, so a swallowed click is diagnosable from the log alone. */
function describeActive(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const el = document.activeElement;
      if (!el) return 'nothing';
      const id = el.id ? `#${el.id}` : '';
      const label = el.getAttribute('aria-label');
      return `${el.tagName.toLowerCase()}${id}${label ? `[aria-label="${label}"]` : ''}`;
    })
    .catch(() => 'unknown');
}

/**
 * Empties the focused field, and confirms it is empty.
 *
 * Needed because the pass check below is a containment test: text typed on top of a leftover partial
 * from a previous attempt would satisfy it while leaving the field holding the phrase twice. On the
 * first attempt the field is already empty, so this is a no-op — only retries depend on the
 * select-all working.
 *
 * @returns false when the field still holds text, which the caller treats as a failed attempt.
 */
async function clearFocusedField(page: Page, selector: string): Promise<boolean> {
  const isEmpty = async () => squash((await readField(page, selector)) ?? '') === '';
  if (await isEmpty()) return true;
  // Scoped to the focused element, which is why the caller confirms focus before calling this.
  await page.keyboard.press('Control+a').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  return await isEmpty();
}

/**
 * Clicks a field, types into it, and CONFIRMS the text arrived.
 *
 * Three defences, in the order the failures actually occur:
 *
 *   1. A sweep AFTER the click, not just before it. Suno mounts its coach mark in response to the
 *      field being clicked, so before the click there is nothing to find — the reason a
 *      before-only sweep silently no-opped. Closing the card moves focus, so the field is clicked
 *      again whenever a card was closed.
 *   2. Focus is verified before a single character is typed. Nothing here can fail on an overlay
 *      (see dismissOnboarding), so a covered field is clicked *through* and the keystrokes go to
 *      whatever does hold focus — the styles text can end up appended to the lyrics, corrupting a
 *      field that already passed its own check. Typing is skipped entirely rather than aimed at the
 *      wrong element, and focus is re-checked every TYPE_CHUNK characters so a card mounting
 *      mid-fill costs at most one chunk.
 *   3. The field is read back and must contain the whole text. Unchecked, an empty field surfaces
 *      much later as the Create button never losing `disabled` and a 15s timeout on the wait for
 *      it — which presents as a stall with the card still on screen, not as a fill failure.
 *
 * Clicks go through `page.click(selector)` rather than `locator.click()` because humanize patches
 * Page and Frame selector-based methods but NOT `Locator.prototype`. Typing keeps its original
 * `page.keyboard.type` shape — that method is patched too — and simply drops the old
 * `{ delay: 100 }`, which the patched implementation ignores in favour of HumanConfig's per-key
 * hold, natural pauses and typo-with-correction. Locators are still used for *waiting*, which
 * needs no humanization.
 *
 * @throws when every attempt leaves the field without the typed text — deliberately louder and far
 *         earlier than the downstream disabled-button timeout it replaces.
 */
async function fillField(
  page: Page,
  selector: string,
  text: string,
  label: string
): Promise<void> {
  // Today a covered click cannot fail, it just misses (see dismissOnboarding). A CloakBrowser that
  // repairs its pointer-events guard would start throwing here instead, and the retry loop below is
  // the right place to handle that — not an exception escaping the fill.
  const click = () =>
    page.click(selector).catch((error: Error) => {
      logger.warn(
        `The click on the ${label} field was refused: ${error.message.split('\n')[0]} — ` +
          'something is on top of it.'
      );
    });

  for (let attempt = 1; attempt <= FILL_ATTEMPTS; attempt++) {
    await page.locator(selector).waitFor({ state: 'visible', timeout: 30000 });

    // A card already on screen sits over the field, so close it before aiming at it...
    await dismissOnboarding(page, ONBOARDING_RECHECK_TIMEOUT);
    await click();

    // ...and again afterwards, because the click is itself the trigger.
    if ((await dismissOnboarding(page, ONBOARDING_POSTCLICK_TIMEOUT)) > 0) {
      logger.info(
        `An onboarding card opened when the ${label} field was clicked; it is closed now, ` +
          're-focusing the field before typing'
      );
      await click();
    }

    if (!(await hasFocus(page, selector))) {
      logger.warn(
        `The ${label} field never took focus — the keyboard is pointed at ${await describeActive(page)}. ` +
          `Not typing, because those keystrokes would land in the wrong place ` +
          `(attempt ${attempt}/${FILL_ATTEMPTS}).`
      );
      continue;
    }

    if (!(await clearFocusedField(page, selector))) {
      logger.warn(
        `Could not clear the ${label} field before retyping, so typing now would duplicate what is ` +
          `already there (attempt ${attempt}/${FILL_ATTEMPTS}).`
      );
      continue;
    }

    let focusLost = false;
    for (let i = 0; i < text.length; i += TYPE_CHUNK) {
      if (i > 0 && !(await hasFocus(page, selector))) {
        focusLost = true;
        break;
      }
      await page.keyboard.type(text.slice(i, i + TYPE_CHUNK));
    }

    // The field's contents are the authority — if everything landed, a focus wobble is irrelevant.
    const got = await readField(page, selector);
    if (got !== null && squash(got).includes(squash(text))) {
      logger.info(`Filled the ${label} field (${text.length} chars)`);
      return;
    }

    logger.warn(
      focusLost
        ? `Something took focus off the ${label} field mid-fill, so typing was stopped there rather ` +
            `than sent to it (attempt ${attempt}/${FILL_ATTEMPTS}).`
        : `The ${label} field did not end up with the text; it holds ` +
            `${JSON.stringify((got ?? '').slice(0, 40))} (attempt ${attempt}/${FILL_ATTEMPTS}).`
    );
  }

  throw new Error(
    `Could not fill the ${label} field on suno.com/create after ${FILL_ATTEMPTS} attempts. Either ` +
      'something on top of the field keeps taking the click, or an onboarding card whose dismiss ' +
      `control no longer matches "${ONBOARDING_DISMISS_SEL}" keeps stealing focus. Re-run with ` +
      'BROWSER_HEADLESS=false to see it.'
  );
}

/**
 * Fills lyrics and style on the create page, switching to the Advanced pane first.
 */
async function fillCreateForm(page: Page, input: BrowserGenerateInput): Promise<void> {
  logger.info('Waiting for Suno interface to load');
  // More robust than waiting on a specific API glob: wait for the create form itself.
  await page.locator(TABLIST_SEL).waitFor({ state: 'visible', timeout: 60000 });

  // Switch to Advanced (custom) mode, but only if it isn't already the active tab.
  const advancedTab = page.locator(ADVANCED_TAB_SEL);
  await advancedTab.waitFor({ timeout: 10000 });
  if ((await advancedTab.getAttribute('aria-selected')) !== 'true') {
    await page.click(ADVANCED_TAB_SEL);
  }

  // A card can mount on its own after the tab switch, so this sweep gets the longer wait. It is not
  // the important one: the cards observed since appear only once a FIELD is clicked, which is why
  // fillField() sweeps both before and after each of its clicks.
  await dismissOnboarding(page, ONBOARDING_LOAD_TIMEOUT);

  // Typing nothing still clicks the field, and the click is what triggers a coach mark — so an empty
  // value is skipped outright rather than "filled" with nothing.
  if (input.prompt.trim()) {
    await fillField(page, LYRICS_SEL, input.prompt, 'lyrics');
  } else {
    logger.warn(
      'No lyrics were supplied, so the lyrics editor is left untouched. That is fine on its own — ' +
        'measured 2026-07-26, the style field alone clears the Create button\'s disabled attribute, ' +
        'so an instrumental generation works with no prompt. But if `tags` is empty too, nothing ' +
        'enables the button and this generation will time out waiting for it.'
    );
  }
  if (input.tags?.trim()) await fillField(page, STYLES_SEL, input.tags, 'style tags');
}

/**
 * Drives suno.com/create end to end and returns the raw `/api/generate/v2-web/` JSON.
 * Used as the captcha bypass when `SunoApi.captchaRequired()` reports true.
 */
export async function generateSongViaBrowser(input: BrowserGenerateInput): Promise<any> {
  return serialize(async () => {
    logger.info('CAPTCHA required. Using CloakBrowser to create the song...');
    const { context, page } = await launchWithRetry();
    try {
      assertHumanized(page);
      await seedCookies(context, input);

      await page.goto('https://suno.com/create', {
        referer: 'https://www.google.com/',
        waitUntil: 'domcontentloaded',
        timeout: 0
      });

      await checkUserAgentDrift(page, input.expectedUserAgent);
      await fillCreateForm(page, input);

      // Set up the intercept BEFORE clicking so the response cannot be missed. Its timeout also
      // has to cover the Turnstile rounds, hence the explicit budget.
      const responsePromise = page.waitForResponse(
        (resp) =>
          resp.url().includes(GENERATE_RESPONSE_PATH) && resp.request().method() === 'POST',
        { timeout: 40000 + TURNSTILE_BUDGET }
      );

      // The Create button starts out disabled="". Measured 2026-07-26: what clears it is the STYLE
      // field, not the lyrics — a 243-char style with the lyrics editor left completely empty was
      // enough, so an instrumental generation needs no prompt at all. Note the button's box also
      // MOVES when it enables (x 264 -> 328, centre 473 -> 505), which is why this is waited on by
      // selector and never by coordinate.
      await page.locator(CREATE_BUTTON_SEL).waitFor({ timeout: 30000 });
      await page.waitForFunction(
        (sel) => {
          const btn = document.querySelector(sel);
          return !!btn && !btn.hasAttribute('disabled');
        },
        CREATE_BUTTON_SEL,
        { timeout: 15000 }
      );
      // Last chance: the Create button sits just below the tour card's lower edge.
      await dismissOnboarding(page, ONBOARDING_RECHECK_TIMEOUT);
      await page.click(CREATE_BUTTON_SEL);

      // And once more after it, for the Turnstile modal's sake: a card mounted in reaction to this
      // click would sit over the challenge. Deliberately no second Create click — repeating it
      // could submit two generations, which costs credits.
      await dismissOnboarding(page, ONBOARDING_RECHECK_TIMEOUT);

      await clickTurnstileIfPresent(page);

      logger.info('Create clicked. Waiting for the API response...');
      const apiResponse = await responsePromise;
      const responseData = await apiResponse.json();

      logger.info('Song creation submitted via browser. Waiting 10 seconds before returning...');
      await sleep(10);
      return responseData;
    } finally {
      // launchContext()'s close() also closes the browser. In a finally so a thrown error can
      // never leak a Chromium process — which would hold the single licence seat and make every
      // later captcha request fail to launch.
      await context.close().catch(() => {});
    }
  });
}
