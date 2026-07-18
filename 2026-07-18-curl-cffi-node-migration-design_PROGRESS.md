# curl-cffi-node migration — progress log

Spec: `docs/superpowers/specs/2026-07-18-curl-cffi-node-migration-design.md`

## Status: DONE — migration complete, built, live-verified, committed locally on `main`
Commit: `ffb9c81` "Migrate SunoApi.ts HTTP transport from axios to curl-cffi-node" (local only, not pushed).

## What's left / needs your review
- Nothing blocking. One thing worth a glance next time you're at the keyboard: `next.config.mjs` now has
  `serverComponentsExternalPackages: ['curl-cffi', '@tocha688/libcurl']` (see assumption #7 below) — this wasn't in
  the spec and was required to make the production build work at all with curl-cffi's native addon. If you disagree
  with that fix, alternatives exist (e.g. per-platform externals only), but this is the standard/minimal Next 14
  mechanism for the problem and works cleanly.
- `npm audit` reports 33 pre-existing vulnerabilities (15 moderate/15 high/3 critical) unrelated to this migration —
  not touched, not investigated, flagging only because `npm install`/`uninstall` printed it every time.

## Summary (read this first)
- Working directly on `main` (user explicitly chose "work in place on main" over an isolated worktree before stepping away).
- Committing locally after each working increment. **Not pushing, not opening PRs.**

## Decisions / assumptions made without asking
1. **Impersonate profile**: picked `chrome131_android` from curl-cffi's installed `CURL_IMPERSONATE_CHROME` union
   (`chrome99_android` | `chrome131_android` are the only Android-flavored options). The current custom headers claim
   `sec-ch-ua: "Chromium";v="130"` + `platform="Android"`, so `chrome131_android` (v131) is the closest available match
   to v130 and is the newer of the two Android profiles. Not asking the user since the spec already delegated this
   choice to "after inspecting the installed package's actual profile union."
2. **Package manager**: repo has both `package-lock.json` and `pnpm-lock.yaml`; `package-lock.json` is newer
   (Jul 4 vs pnpm's May 19), so used `npm install` (npm auto-added `curl-cffi` to `package.json` + `package-lock.json`).
3. **Error message text** for the new non-2xx response interceptor: reused axios's exact default message format
   (`Request failed with status code ${status}`) for continuity in logs.
4. Non-null-asserted `this.cookies.__client!` at the two Clerk call sites (`getAuthToken`, `keepAlive`) — curl-cffi's
   `RequestOptions.headers` is typed `Record<string,string>` (no `| undefined`), stricter than axios's header type.
   Runtime behavior unchanged (these calls already assumed `__client` is present).
5. Header key casing: curl-cffi's `HttpHeaders` normalizes header keys (Title-Case per hyphen segment, except a
   hardcoded lowercase rule for `sec-ch-ua*`/`sec-fetch-*`). E.g. our `x-suno-client` header will go over the wire as
   `X-Suno-Client`. Not flagged in the spec's "known behavior changes" section, but HTTP header names are
   case-insensitive per spec, so this should be functionally inert. Flagging here in case Suno's edge does something
   unusual with header casing (unlikely).
6. **`this.client.post(url, null, opts)` → `this.client.post(url, undefined, opts)`** at the two no-body POSTs in
   `getWavFile` (`downbeats_streaming`, `convert_wav`). curl-cffi-node's `RequestData` type is
   `Record<string,any> | string | URLSearchParams` (no `null`), unlike axios's permissive `any`. Functionally
   equivalent — both end up sending an empty body on a POST used only to trigger a server-side side effect.
7. **`next.config.mjs` needed a new webpack exclusion.** curl-cffi ships a native N-API addon
   (`@tocha688/libcurl-win32-x64-msvc/*.node` on this machine); webpack tried to parse the binary as JS and failed
   the build (`Module parse failed: Unexpected character`). Fixed by adding
   `experimental.serverComponentsExternalPackages: ['curl-cffi', '@tocha688/libcurl']` (the Next 14 mechanism for
   "don't bundle this, leave it as a real runtime `require()`"). This wasn't mentioned in the spec — axios has no
   native addon, so this need only surfaced once the real build ran. Confirmed fix: `next build` now compiles and
   generates all routes successfully.

## Plan
- [x] Read spec, current `SunoApi.ts`, curl-cffi-node technical reference, confirm axios scope (grep confirms
      `src/lib/SunoApi.ts` is the only source file using axios).
- [x] `npm install curl-cffi` (installed 0.1.50; native Windows x86_64 lib auto-downloaded to
      `node_modules/curl-cffi/libs/x86_64-win32_v1.5.6`, so local live smoke testing is possible on this machine).
- [x] Rewrite `src/lib/SunoApi.ts` per the spec's architecture section.
- [x] Remove `axios` from `package.json` dependencies (`npm uninstall axios`; still present transitively via
      `swagger-ui-react`, as the spec calls out as out-of-scope).
- [x] `next build` / typecheck passes — `npx tsc --noEmit` clean, `npm run build` compiles and generates all 16
      routes successfully (after the webpack externals fix, see assumption #7).
- [x] Live smoke test against `SUNO_COOKIE` in `.env`: ran `npm start`, hit `GET /api/get_limit` →
      `200 {"credits_left":8550,"period":"year","monthly_limit":10000,"monthly_usage":1450}` (real data — confirms
      cookie-jar seeding, Clerk auth flow, keepAlive, and Bearer-token injection all work end to end). Also hit
      `POST /api/feed` (`{"nextCursorId":null,"liked":false,"trashed":false}`) → `200` with real clip data (confirms
      the POST path whose manual status check was removed still works correctly on success). Killed the server
      afterward (`taskkill /F` on the listening PID — `pkill` isn't available in this Git Bash environment).
- [x] Commit locally (see commit below).

## Open items for user review
See "What's left / needs your review" at the top.
