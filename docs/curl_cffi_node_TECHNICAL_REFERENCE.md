# curl-cffi-node — Technical Reference

> ASSUMPTION: The published npm package name is `curl-cffi` (`package.json:2`), but the GitHub repository and the project's own identity (`package.json:53-56` `homepage`/`repository` fields, both pointing at `github.com/tocha688/curl-cffi-node`) is `curl-cffi-node`. This document uses **curl-cffi-node** as the canonical application name, to disambiguate from (a) the upstream Python project `curl_cffi` it is inspired by (referenced in `README.md:167`) and (b) its own native dependency `@tocha688/libcurl`. The output filename slug `curl_cffi_node` is derived from this name.

> ASSUMPTION: This document treats curl-cffi-node as a **library**, not a service. "Interfaces & APIs" (Section 5) therefore documents the public exported class/function contracts consumed by embedding applications, not HTTP server routes — this repository contains no HTTP server. "Data Model" (Section 4) documents in-memory value objects and pool state — this repository contains no database.

No OAuth mechanism of any kind (Claude/Anthropic-issued or otherwise) was found anywhere in this repository. A case-insensitive full-repository search for `oauth` (excluding `node_modules`/`.git`) returned zero matches. Section 9 (Security Model) therefore covers only transport-level security (TLS verification, certificates, proxies, cookies); there is no authentication/authorization subsystem to document.

---

## 0. Machine Summary

```yaml
application_name: curl-cffi-node          # ASSUMPTION, see header note
npm_package_name: curl-cffi                # package.json:2
version: "0.1.50"                          # package.json:3
license: MIT                                # LICENSE, package.json:58
description: >
  Node.js HTTP client library built on a fork of libcurl ("curl-impersonate")
  that adds browser TLS/HTTP fingerprint impersonation (JA3/Akamai/HTTP2),
  synchronous and asynchronous request modes, connection pooling, a
  curl_multi-based batch/concurrent transport, cookie-jar sessions, and an
  axios-style interceptor system. (package.json:4, README.md:1-19)

tech_stack:
  language: TypeScript (compiled with tsup/esbuild; tsconfig.json target ES2020)
  runtime: Node.js (native N-API addon dependency; no "engines" field found — see UNVERIFIED in Section 13)
  build_tool: tsup (tsup.config.ts) — dual ESM+CJS output with .d.ts/.d.mts
  test_runner: ava (package.json:33,74-77) for __test__/index.spec.mjs; ad hoc
    scripts under tests/*.ts are NOT wired into any package.json script (see Section 13)
  package_manager: pnpm@10.6.5 (package.json:59, .github/workflows/npm-publish.yml:19,48,97)

entry_points:
  library_entry: src/index.ts                      # compiled to dist/index.js (CJS) / dist/index.mjs (ESM)
  npm_install_hook: scripts/install.cjs             # package.json:32 "install": "node scripts/install.cjs"
  global_singleton_client: src/request/global.ts:getGlobalRequest  # exported as `req` in src/request/index.ts:13
  standalone_function: src/request/request.ts:fetch

top_level_modules:
  - src/app.ts            # native shared-library path resolution
  - src/helper.ts          # RequestOptions -> libcurl option mapping; response parsing
  - src/utils.ts            # URL/cookie/header utilities, timers
  - src/logger.ts           # console logger
  - src/core/CurlPool.ts    # Curl easy-handle pool
  - src/impl/               # transport strategies (sync, multi-timer, multi-event[unused])
  - src/socket/SocketChecker.ts  # socket readiness poller (used only by unused multi-event transport)
  - src/request/            # client classes, sessions, interceptors, global singleton
  - src/type/               # RequestOptions/CurlResponse/HttpHeaders/CURL_IMPERSONATE types + defaults

primary_data_stores: []   # No database of any kind. All state is in-process memory:
                          # CurlPool.items[], CurlMultiTimer.curls Map, global.storageCurls Set.

external_dependencies:
  runtime:
    - "@tocha688/libcurl@0.1.21"   # native N-API binding to a fork of libcurl ("curl-impersonate")
    - "lodash@^4.17.17 (types) / runtime dep"
    - "tough-cookie@^5.1.2"        # CookieJar/Cookie for opts.jar
    - "tar@^7.4.3"                 # install-time tarball extraction
  install_time_network_calls:
    - "https://api.github.com/repos/lexiforest/curl-impersonate/releases"
    - "https://github.com/lexiforest/curl-impersonate/releases/download/<version>/..."
    - "https://curl.se/ca/cacert.pem"
  dev:
    - ava, p-limit, tsup, typescript

oauth_status: NOT_DETECTED   # see repository-wide grep note above; no external OAuth spec file referenced anywhere in this document
```

---

## 1. Architecture

### 1.1 Components and responsibilities

| Component | File(s) | Responsibility |
|---|---|---|
| Native binding layer | external package `@tocha688/libcurl` (not in this repo) | Exposes `Curl`, `CurlMulti` classes and the `CurlOpt`/`CurlInfo`/`CurlMOpt`/`CurlHttpVersion`/`CurlSslVersion`/`CurlIpResolve`/`CurlWsFlag`/`CurlError` enums that wrap a native libcurl-impersonate shared library. |
| Native library bootstrap | `src/app.ts` | Resolves which platform-specific native shared library file to load (`getLibPath`), derived from OS/arch (`getDirName`) and the pinned version in `libcurl.config.json`. |
| Global init/cleanup | `src/impl/index.ts:curlGlobalInit`, `src/request/global.ts` | Calls `setLibPath` once per process before any native call; registers a `process.on('exit', ...)` handler that closes every tracked pool/multi-handle and calls the native `globalCleanup()`. |
| Request-shaping | `src/helper.ts:setRequestOptions` | Single choke point that translates a `RequestOptions` object into a sequence of `curl.setOption(...)` calls on one `Curl` easy handle. |
| Response parsing | `src/helper.ts:parseResponse` | Converts a completed `Curl` handle's raw body/header bytes into a `CurlResponse`, reconstructing the per-redirect-hop chain (`stacks`) and writing `Set-Cookie` values into the caller's cookie jar. |
| Transport strategy: one-shot | `src/impl/request_sync.ts` | `request()`/`requestSync()` call `curl.perform()`/`curl.performSync()` directly on a single easy handle, then `parseResponse`. |
| Transport strategy: multi/batch (production) | `src/impl/curl_multi_timer.ts:CurlMultiTimer` | Wraps `CurlMulti`; drives many concurrent easy handles through one native multi-handle using libcurl's own timer callback plus a background `wait()` loop. Exported as `CurlMultiImpl` (`src/impl/index.ts:8`). |
| Transport strategy: multi/batch (unused) | `src/impl/curl_multi_event.ts:CurlMultiEvent` | Alternate socket-readiness-driven multi-handle transport. Marked `"当前模块未完善 不可用"` ("this module is currently incomplete, not usable") in its own header comment (line 2) and is **not exported** from `src/impl/index.ts`. |
| Socket poller | `src/socket/SocketChecker.ts` | `EventEmitter`-based helper that polls socket readability/writability every 10 ms via `setInterval`; used exclusively by the unused `CurlMultiEvent`. |
| Connection pool | `src/core/CurlPool.ts:CurlPool` | Reuses `Curl` easy handles across calls on the same client instance (`acquire`/`release`/`remove`/`prune`). |
| Convenience API | `src/request/BaseClient.ts:BaseClient` | Abstract class providing `get/post/put/delete/patch/head/options` in terms of an abstract `request()`. |
| Orchestration base | `src/request/RequestClientBase.ts:RequestClientBase` | Abstract class (extends `BaseClient`) that owns a `CurlPool`, an `InterceptorManager` pair, default-option merging, base-URL resolution, CORS preflight, and retry; delegates the actual transfer to an abstract `send()`. |
| Concrete client: single request | `src/request/CurlRequest.ts:CurlRequest` | `send()` picks `requestSync` or `request` from `impl/request_sync.ts` based on `opts.sync`. |
| Concrete client: batch/reused-connection | `src/request/CurlRequestMulti.ts:CurlRequestMulti` | `send()` delegates to a lazily-created `CurlMultiImpl`; adds `batch()` for `Promise.all`-style concurrent submission. |
| Session client | `src/request/session.ts:CurlSession` | `CurlRequest` subclass that injects a `tough-cookie` `CookieJar` into the client's options if none was supplied. |
| Legacy client family | `src/request/client.ts:CurlRequestImplBase`, `CurlClient` | An independent, older implementation of the same convenience-verb + interceptor + retry + CORS feature set, **not** built on `BaseClient`/`RequestClientBase`, kept "to maintain compatibility with existing code" (`src/request/index.ts:11`, Chinese comment `保留旧接口以兼容现有代码`). |
| Standalone function | `src/request/request.ts:fetch` | One-off convenience function: creates a fresh `Curl`, applies options, performs, and returns — no pooling. |
| Global singleton | `src/request/global.ts:getGlobalRequest`, exported as `req` (`src/request/index.ts:13`) | Lazily-constructed process-wide `CurlRequestMulti` instance. |
| Interceptors | `src/request/interceptors.ts:InterceptorManager` | Axios-style request/response interceptor chain with priority ordering and conditional (`runIf`) execution. |
| Cross-cutting utilities | `src/utils.ts`, `src/logger.ts` | URL building, curl-format cookie parsing, raw HTTP header block parsing, a custom self-rescheduling `setInterval`, and a console-based leveled `Logger`. |
| Type/config layer | `src/type/*.ts` | `RequestOptions`, `RequestInitOptions`, `CurlResponse`, `HttpHeaders`, `CURL_IMPERSONATE*` union types, and the `defaultRequestOption`/`defaultInitOptions` default-value objects. |
| Install-time provisioner | `scripts/install.cjs` | Runs as the npm `"install"` lifecycle script; downloads a platform-specific `curl-impersonate` shared-library release tarball and a CA bundle into `<package_root>/libs/`. |

### 1.2 Interaction graph

```mermaid
graph TD
    Consumer["Consumer application code"] -->|imports| Index["src/index.ts"]
    Index --> ReqIndex["src/request/index.ts"]
    ReqIndex --> Global["req singleton\nsrc/request/global.ts:getGlobalRequest"]
    ReqIndex --> CurlRequest["CurlRequest\nsrc/request/CurlRequest.ts"]
    ReqIndex --> CurlRequestMulti["CurlRequestMulti\nsrc/request/CurlRequestMulti.ts"]
    ReqIndex --> CurlSession["CurlSession\nsrc/request/session.ts"]
    ReqIndex --> CurlClientLegacy["CurlClient (legacy)\nsrc/request/client.ts"]
    ReqIndex --> FetchFn["fetch()\nsrc/request/request.ts"]

    CurlSession --> CurlRequest
    CurlRequest --> RCB["RequestClientBase\nsrc/request/RequestClientBase.ts"]
    CurlRequestMulti --> RCB
    RCB --> BaseClient["BaseClient\nsrc/request/BaseClient.ts"]
    RCB --> Pool["CurlPool\nsrc/core/CurlPool.ts"]
    RCB --> Interceptors["InterceptorManager\nsrc/request/interceptors.ts"]
    RCB --> Shared["shared.ts helpers\n(merge/resolveUrl/CORS/retry)"]

    CurlRequest -->|send: sync/async| ImplSync["impl/request_sync.ts"]
    CurlRequestMulti -->|send| ImplMulti["CurlMultiImpl = CurlMultiTimer\nsrc/impl/curl_multi_timer.ts"]
    FetchFn --> ImplSync
    CurlClientLegacy --> ImplSync
    CurlClientLegacy --> ImplMulti

    ImplSync --> Helper["helper.ts\nsetRequestOptions / parseResponse"]
    ImplMulti --> Helper
    Helper --> NativeCurl["Curl / CurlMulti\n(@tocha688/libcurl)"]
    ImplMulti --> NativeCurl

    Index --> App["src/app.ts:getLibPath"]
    App --> NativeLib["Platform native\nlibcurl-impersonate shared library"]
    NativeCurl --> NativeLib

    Unused1["CurlMultiEvent (unused)\nsrc/impl/curl_multi_event.ts"] -.not exported.-> NativeCurl
    Unused1 --> SocketChecker["SocketChecker\nsrc/socket/SocketChecker.ts"]
```

### 1.3 Textual statement of relationships (source of truth; diagram above is derived from these facts)

1. `src/index.ts` re-exports `src/type/*`, `src/request/*`, `src/logger.ts`, `CurlMultiImpl` (from `src/impl/index.ts`), and selected symbols from `@tocha688/libcurl` (`CurlMOpt, CurlHttpVersion, CurlOpt, CurlError, CurlInfo, CurlIpResolve, CurlSslVersion, CurlWsFlag, Curl`), plus `libVersion()`/`libPath()` wrapper functions (`src/index.ts:1-9`).
2. `src/request/index.ts` re-exports `request.ts` (the `fetch` function), `session.ts` (`CurlSession`), `global.ts`, `BaseClient`, `RequestClientBase`, `CurlRequest`, `CurlRequestMulti`, `CurlClient` (legacy), and instantiates the module-level constant `req = getGlobalRequest()` (`src/request/index.ts:1-13`).
3. `CurlSession` (`src/request/session.ts:10`) extends `CurlRequest` and only overrides the constructor to guarantee `opts.jar` is a `CookieJar` (`new CookieJar()` if not supplied).
4. `CurlRequest` (`src/request/CurlRequest.ts:15`) and `CurlRequestMulti` (`src/request/CurlRequestMulti.ts:15`) both extend `RequestClientBase` (`src/request/RequestClientBase.ts:17`), which itself extends `BaseClient` (`src/request/BaseClient.ts:9`).
5. `RequestClientBase`'s constructor creates one `CurlPool` per client instance (`src/request/RequestClientBase.ts:30`, `new CurlPool(poolOptions)`).
6. `RequestClientBase.request()` acquires a `Curl` handle from `this.pool`, calls the abstract `this.send(curl, opts)`, and in a `finally` block either `pool.release(curl)` (default) or `pool.remove(curl)` (if `options.keepAlive === false`) (`src/request/RequestClientBase.ts:47-91`).
7. `CurlRequest.send()` (`src/request/CurlRequest.ts:21-23`) calls either `requestSync(opts, curl)` or `request(opts, curl)`, both imported from `src/impl/request_sync.ts`, depending on `opts.sync`.
8. `CurlRequestMulti.send()` (`src/request/CurlRequestMulti.ts:30-32`) calls `this.multiImpl.request(opts, curl)`, where `multiImpl` lazily instantiates a `CurlMultiImpl` (`= CurlMultiTimer`) if none was passed to the constructor (`src/request/CurlRequestMulti.ts:23-28`).
9. `src/impl/request_sync.ts:request`/`requestSync` and `src/impl/curl_multi_timer.ts:CurlMultiTimer.request` both ultimately call `src/helper.ts:parseResponse(curl, options)` after the native transfer completes.
10. `src/helper.ts:setRequestOptions` is called by `RequestClientBase.request()` (line 66, inside `withRetry`), by the legacy `CurlClient.request()` (`src/request/client.ts:159,170`), and by `src/request/shared.ts:corsPreflightIfNeeded` — it is the single place `RequestOptions` fields are converted to native `curl.setOption(...)` calls.
11. `src/app.ts:getLibPath` is called once, at module-load time, by `src/impl/index.ts:curlGlobalInit()` (line 11, `setLibPath(getLibPath())`), which is itself called once at module-load time by `src/request/global.ts` (line 6, top-level statement). Because `src/index.ts` re-exports `src/request/*`, importing the package's entry point transitively executes `curlGlobalInit()` before any consumer code runs.
12. `src/request/global.ts` maintains a `storageCurls: Set<any>` attached to Node's `global` object (`global.__Tocha_CurlStorage`) so the registry survives potential duplicate module instantiation. `CurlPool` (`src/core/CurlPool.ts:33`), `CurlMultiTimer` (`src/impl/curl_multi_timer.ts:41`), and the lazily-created global `CurlRequestMulti` (`src/request/global.ts:15`) all register themselves into `storageCurls`.
13. `src/request/global.ts:36` registers `process.on('exit', cleanup)`; `cleanup` (lines 21-34) iterates `storageCurls` calling `.close()` on every entry, then calls the native `globalCleanup()` from `@tocha688/libcurl`.
14. `CurlMultiEvent` (`src/impl/curl_multi_event.ts`) depends on `SocketChecker` (`src/socket/SocketChecker.ts`), but neither is imported by any file that is reachable from `src/index.ts` — this transport path is dead code from the package's public surface.

---

## 2. Module & Directory Map

| Path | Responsibility |
|---|---|
| `src/index.ts` | Public package entry point; re-exports types, request classes, logger, `CurlMultiImpl`, and native-binding symbols; exposes `libVersion()`/`libPath()`. |
| `src/app.ts` | Computes `globalLibsPath` (`<package_root>/libs`) and `certPath` (`<libs>/cacert.pem`); `getDirName()` maps `os.arch()`/`os.platform()` to the installer's directory-naming scheme; `getLibPath()` locates the installed native shared library file. |
| `src/helper.ts` | `setRequestOptions(curl, opts, isCors)` — maps a `RequestOptions` object onto native `CurlOpt` calls. `parseResponse(curl, req)` — builds a `CurlResponse` (with per-redirect-hop `stacks`) from raw response bytes/headers. |
| `src/utils.ts` | `buildUrl`, `parseCurlCookies`, `getCookieUrl`, `parseResponseHeaders`, `sleep`, a custom self-rescheduling `setInterval`/`clearInterval` pair (supports `.unref()`), `normalize_http_version`. |
| `src/logger.ts` | `LogLevel` enum and static `Logger` class (console-based, level-gated). |
| `src/core/CurlPool.ts` | `CurlPool` — pool of reusable `Curl` easy handles with idle-TTL pruning. |
| `src/impl/index.ts` | `CurlMultiImpl` (alias of `CurlMultiTimer`); `curlGlobalInit()` (sets the native lib path); re-exports `src/impl/request_sync.ts`. |
| `src/impl/request_sync.ts` | `requestSync(options, curl)` / `request(options, curl)` — one-shot synchronous/asynchronous perform + parse. |
| `src/impl/curl_multi_timer.ts` | `CurlMultiTimer` — production multi-handle transport driven by libcurl's timer callback. |
| `src/impl/curl_multi_event.ts` | `CurlMultiEvent` — socket-event-driven multi-handle transport. **Marked incomplete/unused** (see Section 1.1, 13). |
| `src/socket/SocketChecker.ts` | `SocketChecker` — interval-polling socket readability/writability emitter (used only by `CurlMultiEvent`). |
| `src/type/index.ts` | `defaultRequestOption`, `defaultInitOptions` default-value objects; barrel re-export of `request.ts`/`header.ts`/`response.ts`/`const.ts`. |
| `src/type/request.ts` | `RequestOptions`, `RequestInitOptions`, `FetchOptions`, `CurlOptions`, `CurlRequestInfo`, `RequestEvent`/`ResponseEvent`, `CurlRequestimpl` interface. |
| `src/type/response.ts` | `CurlResponseOptions` type and `CurlResponse` class. |
| `src/type/header.ts` | `HttpHeaders` class (header container backed by `Map<string,string[]>`). |
| `src/type/const.ts` | `CURL_IMPERSONATE_*` union types (Edge/Chrome/Safari/Firefox/default profiles) and the combined `CURL_IMPERSONATE` union. |
| `src/request/index.ts` | Barrel export; instantiates and exports the singleton `req`. |
| `src/request/BaseClient.ts` | `BaseClient` abstract class — `get/post/put/delete/patch/head/options` convenience methods over abstract `request()`. |
| `src/request/RequestClientBase.ts` | `RequestClientBase` abstract class — pool + interceptors + option-merging + CORS + retry orchestration; abstract `send()`. |
| `src/request/CurlRequest.ts` | `CurlRequest` — concrete client using `impl/request_sync.ts`. |
| `src/request/CurlRequestMulti.ts` | `CurlRequestMulti` — concrete client using `CurlMultiImpl`; adds `batch()`. |
| `src/request/session.ts` | `CurlSession` — `CurlRequest` subclass with an auto-provisioned `CookieJar`. |
| `src/request/client.ts` | `CurlRequestImplBase`, `CurlClient` — legacy, parallel client implementation kept for backward compatibility. |
| `src/request/global.ts` | Module-load-time `curlGlobalInit()` call; `storageCurls` global registry; `getGlobalRequest()` singleton factory; `process.on('exit', ...)` cleanup. |
| `src/request/shared.ts` | `mergeDefaultParamsAndData`, `resolveUrlWithBase`, `corsPreflightIfNeeded`, `withRetry` — helpers shared by `RequestClientBase` subclasses. |
| `src/request/interceptors.ts` | `InterceptorManager<T>` — axios-style fulfilled/rejected interceptor chain with priority and `runIf`. |
| `scripts/install.cjs` | npm `install` lifecycle script; downloads the platform-specific `curl-impersonate` release tarball and the `curl.se` CA bundle into `libs/`. |
| `libcurl.config.json` | `{ "version": "vX.Y.Z" }` — pinned/recommended `curl-impersonate` release tag, read by both `scripts/install.cjs` and `src/app.ts`. |
| `tsup.config.ts` | Build configuration (esbuild via tsup): entry `src/index.ts`, dual ESM/CJS output, `.d.ts` generation, `platform: "node"`. |
| `tsconfig.json` | TypeScript compiler options for type-checking `src/**/*` (target ES2020, module CommonJS, `strict: true`); excludes `node_modules`, `dist`, `tests`. |
| `tests/*.ts` | Ad hoc, manually-run integration scripts that perform live network calls against real hosts (e.g. `httpbin.org`, `tls.peet.ws`, `google.com`). **Not** wired into `package.json` scripts (see Section 13). |
| `__test__/index.spec.mjs` | The only automated test, run by `npm test` → `ava` (`package.json:33`). Imports from the **built** `dist/index.mjs`, not from `src/`. |
| `.github/workflows/npm-publish.yml` | CI/CD pipeline: build → matrix test (ubuntu/windows/macos) → conditional npm publish. |
| `package.json` | Manifest: scripts, dependencies, `ava`/`pnpm` config blocks, publish `files` allowlist. |
| `README.md` / `README.zh.md` | User-facing documentation (English / Chinese). > ASSUMPTION: `README.zh.md` is treated as a Chinese translation of `README.md` based on matching structure/headings observed in both files' openings; a full line-by-line diff was not performed. |

---

## 3. Data & Control Flow

### 3.1 Library bootstrap (runs once per process, at import time)

1. Consumer code executes `import { ... } from "curl-cffi"` (or `require(...)`), loading `src/index.ts` (compiled `dist/index.mjs`/`dist/index.js`).
2. `src/index.ts:4` (`export * from "./request"`) triggers evaluation of `src/request/index.ts`, which at line 1 imports `src/request/global.ts`.
3. `src/request/global.ts:6` executes `curlGlobalInit()` (imported from `src/impl/index.ts:10-13`) as a top-level module statement.
4. `curlGlobalInit()` calls `setLibPath(getLibPath())` — `getLibPath` is `src/app.ts:getLibPath` (imported), a native `setLibPath` from `@tocha688/libcurl`.
5. `src/app.ts:getLibPath()` (lines 32-88): computes `name = getDirName()` (arch/platform mapping, lines 11-30); verifies `globalLibsPath` (`<package_root>/libs`) exists, throwing `Error("Global libs directory not found: ...")` if not (line 42); reads `libcurl.config.json` for a preferred version (line 48); scans `libs/` for directories named `${name}_${version}`; if the preferred-version directory exists and contains one of the platform's candidate library filenames, returns that path; otherwise scans all installed version directories, sorts them descending by parsed semantic version (`parseVer`/`cmpDesc`, lines 68-79), and returns the newest match; throws `Error("libcurl not found under ...")` if nothing matches (line 87).
6. `src/request/global.ts:9` initializes `storageCurls` on `global.__Tocha_CurlStorage` (created once, reused across any duplicate module instances).
7. `src/request/global.ts:36` registers `process.on('exit', cleanup)`.
8. `src/request/index.ts:13` evaluates `export const req = getGlobalRequest();` — this call is **not** lazy at the statement level (the constant is computed at module-load time), but `getGlobalRequest()` itself only constructs a `CurlRequestMulti` on first invocation and memoizes it in the closure variable `_req` (`src/request/global.ts:11-18`).

### 3.2 Single request via `CurlRequest`/`BaseClient` (async, default path)

1. Consumer calls e.g. `client.get(url, options)` — `src/request/BaseClient.ts:12-14` — which calls `this.request({ ...options, url, method: "GET" })`.
2. `RequestClientBase.request(options)` (`src/request/RequestClientBase.ts:47-91`):
   a. `const curl = this.pool.acquire();` (line 48) — see Section 3.6 for pool semantics.
   b. `let opts = this.prepareOptions(options);` (line 49) — `prepareOptions` (lines 33-43) strips `baseUrl` from the per-call options, deep-merges `this.opts` (client defaults) with the per-call options via `lodash.merge`, calls `mergeDefaultParamsAndData(this.opts, opts)` (`src/request/shared.ts:9-61`) to combine default and per-call `params`/`data`, and resolves relative URLs against `this.baseUrl` via `resolveUrlWithBase` (`src/request/shared.ts:66-72`).
   c. Request interceptors run: `opts = await this.interceptors.request.runFulfilled(opts)`; on throw, `this.interceptors.request.runRejected(err, opts)` is given a chance to recover (lines 52-58).
   d. `await corsPreflightIfNeeded(curl, opts)` (line 60) — if `opts.cors` is truthy, issues a synthetic `OPTIONS` preflight request first (`src/request/shared.ts:77-94`), dynamically importing `request`/`requestSync` from `src/impl/request_sync.ts` to avoid a circular import.
   e. `res = await withRetry(opts.retryCount ?? 0, async () => { curl.reset(); await setRequestOptions(curl, opts); return await this.send(curl, opts); });` (lines 62-68) — see Section 3.7 for `setRequestOptions`.
   f. `this.send(curl, opts)` — for `CurlRequest`, calls `requestSync`/`request` from `src/impl/request_sync.ts` (`src/request/CurlRequest.ts:21-23`) depending on `opts.sync`.
   g. `src/impl/request_sync.ts:request` (lines 14-21): `await curl.perform();` then `return parseResponse(curl, options);` (Section 3.8).
   h. On error inside the retry block, response interceptors are given a chance to recover (`this.interceptors.response.runRejected(err)`, lines 69-74); otherwise the error propagates.
   i. Response interceptors run over the successful result: `return await this.interceptors.response.runFulfilled(res);` (line 77), with the same rejected-handler recovery pattern (lines 78-81).
   j. `finally`: if `options.keepAlive === false`, `this.pool.remove(curl)` (closes and discards the handle); otherwise `this.pool.release(curl)` (returns it to the pool) (lines 83-89).
3. The resolved `CurlResponse` is returned to the caller.

### 3.3 Synchronous request (`opts.sync = true`)

Identical control flow to 3.2 except step 2f/2g call `requestSync(opts, curl)` (`src/impl/request_sync.ts:5-12`), which calls `curl.performSync()` (a blocking native call) instead of `await curl.perform()`, then the same `parseResponse(curl, options)`. `RequestClientBase.request()` itself is still an `async function`, so the outer call remains `Promise`-returning even though the underlying transfer blocks the JS thread synchronously.

### 3.4 Session request (`CurlSession`)

1. `new CurlSession(opts)` (`src/request/session.ts:10-16`) calls `super({ ...opts, jar: opts?.jar ?? new CookieJar() }, poolOptions)`, i.e. it is a `CurlRequest` whose `RequestInitOptions.jar` is guaranteed to be a `tough-cookie` `CookieJar`.
2. All subsequent request/response flow is identical to Section 3.2/3.3. The only behavioral difference is that `src/helper.ts:setRequestOptions` (Section 3.7) will find `opts.jar` set and merge jar-stored cookies into the outgoing `Cookie` header, and `src/helper.ts:parseResponse` (Section 3.8) will write `Set-Cookie` response headers back into that same jar.

### 3.5 Batch/concurrent requests via `CurlRequestMulti`

1. `client.batch(requests)` (`src/request/CurlRequestMulti.ts:37-40`) maps each `RequestOptions` in the input array to `this.request(r)` and returns `Promise.all(tasks)`.
2. Each individual `this.request(r)` follows the same `RequestClientBase.request()` flow as Section 3.2, except step 2f calls `CurlRequestMulti.send()` (`src/request/CurlRequestMulti.ts:30-32`), which calls `this.multiImpl.request(opts, curl)`.
3. `multiImpl` getter (lines 23-28) lazily constructs one `CurlMultiImpl` (`= CurlMultiTimer`) shared across all calls on this client instance if none was passed to the constructor.
4. `CurlMultiTimer.request(ops, curl)` (`src/impl/curl_multi_timer.ts:143-163`): wraps the call in a `new Promise((resolve, reject) => {...})`; stores `{options, curl, resolve, reject}` in `this.curls` keyed by `curl.id()` (line 145); calls `this.addHandle(curl)` (adds the easy handle to the native multi stack, line 152); calls `this.waitResult()` (see step 6) and schedules `setImmediate(() => { if (!this.closed) this.processData(); })` (lines 157-161) to kick the multi loop immediately rather than waiting for the first timer callback.
5. `setupCallbacks()` (lines 48-66) registers a native `setTimerCallback`. When libcurl reports `timeoutMs === -1`, all pending JS timers are cleared and `checkProcess()` runs immediately (lines 55-58); otherwise a `setTimeout(() => this.processData(), args.timeoutMs)` is scheduled and pushed onto `this.timers` (lines 60-63).
6. `waitResult()` (lines 68-77): guarded by `isRunning` so only one instance runs concurrently; loops `do { await this.wait(10000); await this.processData(); } while (this.curls.size > 0)` — i.e. it blocks (with a native, timeout-bounded wait) and drains completions until no requests are in flight.
7. `processData()` (lines 79-98): calls `this.perform()` (native multi-perform); if the returned running-handle count is `<= 0`, returns early; otherwise calls `checkProcess()`.
8. `checkProcess()` (lines 101-141): loops `this.infoRead()` until it returns falsy; for each `CURLMSG_DONE` message, looks up the pending call by `msg.easyId` in `this.curls`, deletes it from the map, calls `this.removeHandle(call.curl)`; if `msg.data.result === 0` (native success): reads `CurlInfo.ResponseCode`; if the status is `< 100` (implausible/absent), rejects with `new Error(call.curl.error(status))`; otherwise resolves with `parseResponse(call.curl, call.options)`. If `msg.data.result !== 0` (native transport failure), rejects with `new Error(call.curl.error(msg.data.result))`.
9. Back in `RequestClientBase.request()`, the resolved/rejected promise flows through the same interceptor/retry/pool-release logic as Section 3.2.

### 3.6 `CurlPool` acquire/release lifecycle

1. `acquire()` (`src/core/CurlPool.ts:36-55`): finds the first item with `busy === false` and marks it busy; if none exists and `this.items.length < this.maxSize` (default `Infinity`), constructs `new Curl()`, records it as a busy `PoolItem`, and returns it; if the pool is at `maxSize`, constructs and returns an **untracked** `new Curl()` that is not added to `this.items`.
2. `release(curl)` (lines 57-66): if `curl` is found in `this.items`, marks it `busy = false` and updates `lastUsed`; if `curl` is **not** found (i.e. it was one of the untracked overflow handles from step 1, or a handle from another pool), it is closed immediately via `curl.close()` — this is how overflow/temporary handles are cleaned up.
3. `remove(curl)` (lines 68-76): closes the handle if not already closed, and splices it out of `this.items` if present.
4. `startPrune()`/`prune()` (lines 78-96): an `unref()`'d `setInterval` (native Node `setInterval`, not the custom one in `utils.ts`) runs every `min(idleTTL, 60_000)` ms; `prune()` closes and drops every idle item whose `lastUsed` is older than `idleTTL` (default `60_000` ms).
5. `close()` (lines 100-107): clears the prune timer, closes every tracked item, and empties `this.items`.
6. The `CurlPool` constructor (lines 29-34) itself calls `storageCurls.add(this)` — every `CurlPool` instance, not just multi-handle transports, is tracked for process-exit cleanup.

### 3.7 `setRequestOptions` — RequestOptions → native curl options (`src/helper.ts:8-226`)

Executed once per attempt (i.e. once per retry iteration) immediately before the transfer. Ordered effects on the `Curl` easy handle:

1. `opts = { ...defaultRequestOption, ...opts }` (line 10) — re-applies package-level defaults on top of whatever was already merged upstream.
2. URL: `buildUrl(opts.url, opts.params)` (`src/utils.ts:6-14`) parses `opts.url` as a `URL`, stringifies `opts.params` via Node's `querystring`, and sets each resulting key/value into `url.searchParams` (overwriting, not appending, same-named params) — `CurlOpt.Url`.
3. Method: `POST` → `CurlOpt.Post = 1`; any other non-`GET` method → `CurlOpt.CustomRequest = method`; `HEAD` additionally sets `CurlOpt.Nobody = 1` (lines 12-20).
4. Body encoding (lines 24-49): `URLSearchParams` → url-encoded string, content-type forced to `application/x-www-form-urlencoded` **only if a Content-Type header was already present**; `Buffer` → passed through, content-type forced to `application/octet-stream` under the same existing-header condition; other objects → `JSON.stringify`, content-type forced to `application/json` under the same condition; strings pass through unchanged; anything else becomes `""`. If body is truthy or method is `POST`/`PUT`/`PATCH`, `curl.setBody(body)` is called, and if the method was `GET` with a body it is force-set to `CurlOpt.CustomRequest = "GET"` (i.e. a GET-with-body).
5. Headers: built via `new HttpHeaders(opts.headers)`; the `Expect` header is always deleted (line 60, "never send `Expect` header"); flattened via `headers.toArray()` into `curl.setHeadersRaw(...)`.
6. Cookies (lines 63-92): always sets `CurlOpt.CookieFile = ""` and `CurlOpt.CookieList = 'ALL'` (both required by the native binding's cookie-engine activation, independent of whether a jar is supplied). If a `Cookie` header is present, it is parsed into a `Map<string,string>` (semicolon-split, first-`=`-split); if `opts.jar` is present, `jar.getCookiesSync(currentUrl)` results are merged into the same map (jar entries do **not** override an explicit `Cookie` header key that was already set, because `Map.set` on an existing key from the header path runs first and jar values are added afterward using `cookies.set(cookie.key, cookie.value)`, which **does** overwrite same-named keys — i.e. jar cookies win over header cookies for identically-named cookies, since the jar loop runs after the header loop). The merged map is serialized as `k=v; k=v` and passed to `curl.setCookies(...)`.
7. Auth: `opts.auth.{username,password}` → `CurlOpt.Username`/`CurlOpt.Password` (basic/negotiated auth is delegated entirely to native libcurl; no auth-scheme selection logic exists in this repository).
8. Timeout: `opts.timeout ?? 0`; if `> 0`, `CurlOpt.TimeoutMs = opts.timeout` (a commented-out block, lines 105-110, documents an abandoned intent to special-case streaming transfers with `LOW_SPEED_LIMIT`/`LOW_SPEED_TIME` — not implemented).
9. Redirects: `CurlOpt.FollowLocation = opts.allowRedirects ?? true`; `CurlOpt.MaxRedirs = opts.maxRedirects ?? 30` (see Section 12 item 9 for the interaction with `defaultRequestOption.maxRedirects = 5`).
10. Proxy (lines 117-127): if `opts.proxy` is set, parsed as a `URL`; `CurlOpt.Proxy = protocol + '//' + host`; if the proxy scheme is not `socks*`, `CurlOpt.HttpProxyTunnel = true`; if the URL carries userinfo, `CurlOpt.ProxyUsername`/`CurlOpt.ProxyPassword` are set from it.
11. TLS verification (lines 129-138): `opts.verify === false` → `CurlOpt.SslVerifyPeer = 0`, `CurlOpt.SslVerifyHost = 0` (verification fully disabled). Otherwise (default) → `CurlOpt.SslVerifyPeer = 1`, `CurlOpt.SslVerifyHost = 2`, `CurlOpt.CaInfo = certPath`, `CurlOpt.ProxyCaInfo = certPath` (`certPath` = `src/app.ts:9`, `<libs>/cacert.pem`, downloaded at install time).
12. Impersonation (lines 141-143): if `opts.impersonate` is set, `curl.impersonate(opts.impersonate, opts.defaultHeaders ?? true)` — this native call is responsible for the TLS ClientHello/JA3 fingerprint and default browser-header injection; the exact set of headers/ciphers it applies is implemented inside `@tocha688/libcurl`, not in this repository (see UNVERIFIED, Section 13).
13. `Referer` (line 146-148), `Accept-Encoding` (149-152), client cert (`opts.cert` as a string → `CurlOpt.SslCert`; as `{cert,key}` → `CurlOpt.SslCert`/`CurlOpt.SslKey`, lines 154-160).
14. HTTP version (lines 162-167): only set explicitly when `opts.impersonate` is **not** set — if `opts.impersonate` is set, the impersonation profile itself dictates the HTTP version and this code path is skipped entirely. Without impersonation: defaults to `normalize_http_version('v2')` if `opts.httpVersion` is absent, else `normalize_http_version(opts.httpVersion)`.
15. `interface` (176-179), `ipType` → `CurlOpt.IpResolve` (`ipv4`→1, `ipv6`→2, `auto`→0, lines 182-194).
16. Keep-alive (lines 197-201): if `opts.keepAlive === false` **and** `isCors === false`, sets `CurlOpt.TcpKeepAlive = 0` and `CurlOpt.FreshConnect = 1` (forces a brand-new connection, bypassing any native connection cache).
17. `dev` (203-207): `opts.dev` → `CurlOpt.Verbose = 1` (native libcurl verbose wire-protocol logging).
18. `maxRecvSpeed` (line 209): always set, `opts.maxRecvSpeed ?? 0` (`0` disables the cap — explicitly commented as intentional since `0` is a valid disabling value, not "unset").
19. Arbitrary passthrough (lines 211-224): any key/value in `opts.curlOptions` (typed `Record<CurlOpt, string|number|boolean>`) is applied via `curl.setOption(key, value)` for `string`/`number`/`boolean` values, letting callers set any native option not otherwise exposed by `RequestOptions`.

### 3.8 `parseResponse` — native output → `CurlResponse` (`src/helper.ts:229-270`)

1. `dataRaw = curl.getRespBody()` — the final response body bytes (post-redirect, since libcurl performed the redirect chain internally under `CurlOpt.FollowLocation`).
2. `headerRaw = curl.getRespHeaders().toString('utf-8')` — the **entire concatenated raw header blob**, which the native binding surfaces as one or more `HTTP/...` status-line-delimited blocks, one block per hop of the redirect chain that libcurl internally followed.
3. `parseResponseHeaders(headerRaw)` (`src/utils.ts:39-56`) splits the blob on `\r\n`, starting a new `HttpHeaders` instance each time a line begins with `HTTP/` (capturing that line as `.head`), and calling `.set(key, value)` for every `key: value` line — producing an ordered array of one `HttpHeaders` object per hop.
4. For each header block (`hds.forEach`, lines 239-267): clones the running `nextReq` (a `RequestOptions`) into `treq`; builds a `CurlResponse` for this hop with `headers = header`, `request = treq`, `options = req`, `stacks`, `index = stacks.length`, `curl`; sets `res.redirects = Math.max(0, stacks.length - 1)`; sets `treq.response = res` (creating the `CurlRequestInfo`/`CurlResponse` back-reference cycle described in Section 4). If this hop's headers include a `location`, the **next** hop's URL is resolved (`new URL(location, treq.url)`), method is forced back to `GET`, and `data` cleared — mirroring standard redirect semantics — and the raw `dataRaw` is **not** attached to this (redirect) hop's response. If there is no `location` header (i.e. this is the final hop), `res.dataRaw = dataRaw` is attached. If `req.jar` is set, every `Set-Cookie` value on this hop's headers is written into the jar via `jar.setCookieSync(cookie, treq.url)` — cookies are applied per-hop, using each hop's own URL as the cookie's origin.
5. `stacks.push(treq)` after each hop.
6. The function returns `stacks[stacks.length - 1].response` — the **final** hop's `CurlResponse`; all intermediate hops remain reachable via `finalResponse.stacks[i].response`.

### 3.9 Legacy `CurlClient.request()` flow (`src/request/client.ts:144-187`)

An independent implementation of essentially the same steps as Section 3.2/3.5, with these concrete differences:
1. `getCurl()` (lines 135-137) always returns `new Curl()` — **no pooling**; a fresh native handle is allocated per call.
2. If `opts.cors` is set, a synthetic `OPTIONS` preflight is issued inline before the main request (lines 148-161), not via the shared `corsPreflightIfNeeded` helper.
3. Retry is an inline `do { ... } while (retryCount-- > 0)` loop (lines 163-183) that logs each retry via `console.warn(...)` directly (not through `Logger`).
4. Request/response hooks are two plain arrays (`this.reqs`, `this.resps`) invoked sequentially by `emits()` (lines 94-101) — a simpler, non-priority, non-`runIf`, non-error-recovery model than `InterceptorManager`.
5. `beforeResponse()` (lines 139-142) always calls `curl.close()` after building the response — since handles are never pooled, they are unconditionally destroyed after one use.
6. If `this.multi` (a `CurlMultiImpl`) was supplied via the `CurlOptions.impl` constructor option, `send()` (lines 125-133) delegates to it instead of `impl/request_sync.ts`; `initOptions()` (lines 112-123) additionally tunes `CurlMOpt.Pipelining`, `CurlMOpt.MaxConnects` (default `10`), and `CurlMOpt.MaxConcurrentStreams` (default `500`) on that multi handle — tuning that `CurlRequestMulti` (the modern class) never performs (see Section 12 item 10).

### 3.10 Standalone `fetch()` (`src/request/request.ts:7-16`)

1. `options.url = url; options.data = options.body;` — `FetchOptions.body` is aliased onto `RequestOptions.data`.
2. `const curl = new Curl();` — no pooling, no client instance, no interceptors, no retry.
3. `setRequestOptions(curl, options)` (note: **not awaited** in the source — `setRequestOptions` is a synchronous function, so this has no practical effect, but the call itself is not `await`-prefixed at `src/request/request.ts:11`).
4. Returns `requestSync(options, curl)` or `request(options, curl)` from `src/impl/request_sync.ts` depending on `options.sync`.

### 3.11 Process-exit cleanup

1. Node emits the `'exit'` event during process shutdown.
2. `src/request/global.ts:cleanup` (lines 21-34) runs exactly once (guarded by a `cleaned` boolean).
3. Every entry in `storageCurls` (every `CurlPool`, `CurlMultiTimer`/`CurlRequestMulti`, and the global singleton) has `.close()` called, with individual failures swallowed (`try { item.close(); } catch { }`).
4. `globalCleanup()` (native, from `@tocha688/libcurl`) is called last, inside its own `try/catch`.

---

## 4. Data Model

There is no database, ORM, or persistent schema in this repository. All "entities" below are in-process TypeScript types/classes and in-memory collections; state does not survive process restart.

### 4.1 Entity table

| Entity | Kind | File:Symbol | Key fields | Nullability | Notes |
|---|---|---|---|---|---|
| `RequestOptions` | type | `src/type/request.ts:21` | `method?`, `url?`, `params?`, `data?`, `jar?`, `headers?`, `auth?`, `timeout?`, `allowRedirects?`, `maxRedirects?`, `proxy?`, `referer?`, `acceptEncoding?`, `impersonate?`, `ja3?`, `akamai?`, `defaultHeaders?`, `defaultEncoding?`, `httpVersion?`, `interface?`, `cert?`, `verify?`, `maxRecvSpeed?`, `curlOptions?`, `ipType?`, `impl?`, `retryCount?`, `keepAlive?`, `sync?`, `dev?`, `cors?` | Every field optional | Per-call request configuration. `ja3`/`akamai` fields are declared in the type (lines 41-42) but **not read anywhere** in `src/helper.ts:setRequestOptions` — UNVERIFIED/dead field, see Section 13. |
| `RequestInitOptions` | type | `src/type/request.ts:70` | `Omit<RequestOptions, "method"\|"url"\|"params"\|"data">` plus `baseUrl?`, `params?` (client-level defaults), `defaultData?` | All optional | Per-client-instance default configuration, passed to `RequestClientBase`/legacy `CurlRequestImplBase` constructors. |
| `FetchOptions` | type | `src/type/request.ts:79` | `RequestOptions & { body?, sync? }` | optional | Input type for `src/request/request.ts:fetch`. |
| `CurlOptions` | type | `src/type/request.ts:85` | `RequestOptions & { MaxConnects?, MaxConcurrentStreams? }` | optional | Input type for legacy `CurlClient` constructor only. |
| `CurlRequestInfo` | type | `src/type/request.ts:90` | `RequestOptions & { response: CurlResponse }` | `response` required | One instance per redirect hop; forms `CurlResponse.stacks[]`. |
| `CurlResponse` | class | `src/type/response.ts:18` | `url: string`, `status: number`, `dataRaw?: Buffer`, `headers: HttpHeaders`, `request: CurlRequestInfo`, `options: RequestOptions`, `stacks: CurlRequestInfo[]`, `index: number`, `redirects: number`, `curl: Curl` | `dataRaw` optional (absent on redirect-hop responses, see 3.8) | `status` is derived from `headers.status` at construction time (line 33), i.e. computed once from the `HTTP/...` status line, not re-read live. `.text` (getter, lines 42-46) is `dataRaw?.toString('utf-8')`. `.data` (getter, lines 48-55) attempts `JSON.parse(this.text)`, falling back to the raw text string on parse failure — **there is no way to distinguish "body is a JSON-parseable string" from "body is literally that string"** via `.data` alone; callers needing the raw text must use `.text`. `.jar` (getter, lines 58-60) returns `this.request.jar`. |
| `HttpHeaders` | class | `src/type/header.ts:1` | `head?: string` (status line), `headers: Map<string,string[]>` | — | Header keys are normalized (`normalizeKey`, lines 47-60): `sec-ch-ua*`/`sec-fetch-*` are forced lower-case (line 6-14 hardcoded set); all other keys are Title-Cased per hyphen-segment (e.g. `content-type` → `Content-Type`). `.set()` **appends** to any existing array for that key unless an array is passed directly (lines 62-71) — repeated `.set(key, singleValue)` calls accumulate multiple values under one key. `.get()`/`.first()`/`.delete()`/`.has()` all normalize the key first. `.status` (getter, lines 41-44) regex-extracts the numeric code from `.head`. |
| `CurlResponseOptions` | type | `src/type/response.ts:7` | `headers`, `dataRaw?`, `request`, `url`, `stacks?`, `options`, `index?`, `curl` | `headers`/`request`/`url`/`options`/`curl` required | Constructor-argument shape for `CurlResponse`. |
| `PoolItem` | private type | `src/core/CurlPool.ts:5` | `curl: Curl`, `busy: boolean`, `lastUsed: number` | — | One per pooled native handle; not exported. |
| `CurlData` | private type | `src/impl/curl_multi_timer.ts:25` | `curl`, `options`, `resolve`, `reject` | — | One per in-flight multi-handle request, keyed by `curl.id()` in `CurlMultiTimer.curls: Map<string, CurlData>`. |
| `CookieJar` / `Cookie` | external class | `tough-cookie` package | RFC-6265 cookie store | — | Not defined in this repository; used as `RequestOptions.jar`/`RequestInitOptions.jar`. |
| `defaultRequestOption` | const value | `src/type/index.ts:5-17` | `method:'GET'`, `timeout:30000`, `allowRedirects:true`, `maxRedirects:5`, `verify:true`, `acceptEncoding:'gzip, deflate, br, zstd'`, `ipType:'auto'`, `defaultHeaders:true`, `maxRecvSpeed:0` | — | Applied by `setRequestOptions` (helper.ts:10) and by `RequestClientBase`'s constructor (via `defaultInitOptions`). |
| `defaultInitOptions` | derived const | `src/type/index.ts:20` | `_.omit(defaultRequestOption, ["method","url","params","data"])` | — | Used as the default constructor argument for `RequestClientBase`/legacy `CurlRequestImplBase`. |

### 4.2 Entity-relationship diagram

```mermaid
classDiagram
    class RequestOptions {
      +method?
      +url?
      +params?
      +data?
      +jar? CookieJar
      +headers?
      +auth?
      +impersonate?
      +cors?
      +retryCount?
    }
    class RequestInitOptions {
      +baseUrl?
      +params?
      +defaultData?
    }
    RequestInitOptions --|> RequestOptions : Omit method/url/params/data, adds baseUrl/defaultData

    class CurlRequestInfo {
      +response CurlResponse
    }
    CurlRequestInfo --|> RequestOptions

    class CurlResponse {
      +url string
      +status number
      +dataRaw? Buffer
      +headers HttpHeaders
      +request CurlRequestInfo
      +options RequestOptions
      +stacks CurlRequestInfo[]
      +index number
      +redirects number
      +curl Curl
      +text() string
      +data() any
      +jar() CookieJar
    }
    CurlResponse "1" --> "1" CurlRequestInfo : request
    CurlResponse "1" --> "0..*" CurlRequestInfo : stacks (one per redirect hop)
    CurlRequestInfo "1" --> "1" CurlResponse : response (back-reference)

    class HttpHeaders {
      +head? string
      +headers Map~string, string[]~
      +status() number
      +set(key, value)
      +get(key)
    }
    CurlResponse "1" --> "1" HttpHeaders : headers

    class CookieJar {
      <<external: tough-cookie>>
    }
    RequestOptions --> CookieJar : jar

    class PoolItem {
      +curl Curl
      +busy boolean
      +lastUsed number
    }
    class CurlPool {
      +items PoolItem[]
      +maxSize number
      +idleTTL number
      +acquire() Curl
      +release(curl)
      +remove(curl)
      +prune()
      +close()
    }
    CurlPool "1" --> "0..*" PoolItem : items

    class CurlData {
      +curl Curl
      +options RequestOptions
      +resolve
      +reject
    }
    class CurlMultiTimer {
      +curls Map~string, CurlData~
      +request(ops, curl)
    }
    CurlMultiTimer "1" --> "0..*" CurlData : curls (keyed by curl.id())
```

### 4.3 Textual statement of the same relationships

1. `RequestInitOptions` (`src/type/request.ts:70`) is `RequestOptions` (`src/type/request.ts:21`) with `method`/`url`/`params`/`data` removed and `baseUrl`/`params` (redefined as client-default)/`defaultData` added.
2. `CurlRequestInfo` (`src/type/request.ts:90`) is `RequestOptions` plus a required `response: CurlResponse` field.
3. `CurlResponse.request` is one `CurlRequestInfo` (the hop that produced this specific response object); `CurlResponse.stacks` is zero-or-more `CurlRequestInfo` entries, one per redirect hop, built by `src/helper.ts:parseResponse`.
4. Each `CurlRequestInfo.response` points back at the `CurlResponse` for that same hop (assigned at `src/helper.ts:252`, `treq.response = res`) — this is an intentional bidirectional reference cycle scoped to a single request's lifetime, not a persisted graph.
5. `CurlResponse.headers` is exactly one `HttpHeaders` instance (the final hop's headers, since `parseResponse` returns `stacks[stacks.length-1].response`).
6. `RequestOptions.jar` (when present) references a `tough-cookie` `CookieJar`, an external, mutable, shared object — the same `CookieJar` instance is read from (`getCookiesSync`) before the request and written to (`setCookieSync`) after each hop's response, meaning **the jar can be mutated even for redirect hops that are not the final response the caller sees**.
7. `CurlPool.items` is zero-or-more `PoolItem`, each wrapping exactly one native `Curl` handle plus pool bookkeeping (`busy`, `lastUsed`); this collection is private to one `CurlPool` instance, which is private to one `RequestClientBase` (and thus one `CurlRequest`/`CurlRequestMulti`/`CurlSession`) instance.
8. `CurlMultiTimer.curls` is a `Map` from the native `curl.id()` string to a `CurlData` record; this map's size directly gates the `waitResult()` loop's termination condition (`while (this.curls.size > 0)`).

---

## 5. Interfaces & APIs

curl-cffi-node exposes no network-listening interface; it is an embedded library. This section documents its public exported API contract as consumed by an embedding Node.js application.

### 5.1 Package entry exports (`src/index.ts:1-9`)

| Export | Kind | Source | Notes |
|---|---|---|---|
| `CurlMOpt, CurlHttpVersion, CurlOpt, CurlError, CurlInfo, CurlIpResolve, CurlSslVersion, CurlWsFlag, Curl` | re-export | `@tocha688/libcurl` | Native enums/class passed through unmodified. |
| `*` from `./type` | re-export | `src/type/index.ts` | All request/response/header/const types + `defaultRequestOption`/`defaultInitOptions`. |
| `*` from `./request` | re-export | `src/request/index.ts` | All client classes + `req` singleton + `fetch`. |
| `*` from `./logger` | re-export | `src/logger.ts` | `Logger`, `LogLevel`. |
| `CurlMultiImpl` | re-export | `src/impl/index.ts:8` | `= CurlMultiTimer`. |
| `libVersion()` | function | `src/index.ts:7` | `() => getVersion()` — native libcurl version string, e.g. must contain the substring `"curl"` (asserted in `__test__/index.spec.mjs:18`). |
| `libPath()` | function | `src/index.ts:8` | `() => getLibPathBase()` — the native `getLibPath` from `@tocha688/libcurl` (not `src/app.ts`'s own `getLibPath`, despite the similar name — these are two different functions). |

### 5.2 `BaseClient` (`src/request/BaseClient.ts:9`, abstract)

| Method | Signature | Returns | Throws |
|---|---|---|---|
| `request` | `abstract request(options: RequestOptions): Promise<CurlResponse>` | `Promise<CurlResponse>` | Implementation-defined; must be implemented by subclasses. |
| `get` | `get(url: string, options?: RequestOptions): Promise<CurlResponse>` | `Promise<CurlResponse>` | Delegates to `request({...options, url, method:"GET"})`. |
| `post` | `post(url: string, data?: RequestData, options?: RequestOptions): Promise<CurlResponse>` | `Promise<CurlResponse>` | `RequestData = Record<string,any> \| string \| URLSearchParams`. |
| `put` | `put(url: string, data?: RequestData, options?: RequestOptions): Promise<CurlResponse>` | `Promise<CurlResponse>` | — |
| `delete` | `delete(url: string, data?: RequestData, options?: RequestOptions): Promise<CurlResponse>` | `Promise<CurlResponse>` | — |
| `patch` | `patch(url: string, data?: RequestData, options?: RequestOptions): Promise<CurlResponse>` | `Promise<CurlResponse>` | — |
| `head` | `head(url: string, options?: RequestOptions): Promise<CurlResponse>` | `Promise<CurlResponse>` | — |
| `options` | `options(url: string, options?: RequestOptions): Promise<CurlResponse>` | `Promise<CurlResponse>` | Name collides conceptually with `RequestOptions` but is a distinct HTTP-OPTIONS convenience method. |

### 5.3 `RequestClientBase` (`src/request/RequestClientBase.ts:17`, abstract, extends `BaseClient`)

| Member | Signature | Contract |
|---|---|---|
| constructor | `constructor(opts: RequestInitOptions = defaultInitOptions clone, poolOptions: CurlPoolOptions = {})` | Always merges `opts` over `defaultInitOptions` (line 28) — defaults are guaranteed applied regardless of whether `opts` is supplied. |
| `request` | `request(options: RequestOptions): Promise<CurlResponse>` | Full orchestration per Section 3.2. Resolves with a `CurlResponse` even for HTTP error status codes (4xx/5xx); rejects only on transport-level failure or an unrecovered interceptor rejection. |
| `send` | `protected abstract send(curl: Curl, opts: RequestOptions): Promise<CurlResponse>` | Must be implemented by concrete subclasses; called once per retry attempt. |
| `jar` | `get jar()` | Returns `this.opts.jar` (may be `undefined`). |
| `baseURL` | `get baseURL()` | Returns `this.baseUrl` (may be `undefined`). |
| `close` | `close(): void` | Calls `this.pool.close()` — closes every pooled `Curl` handle. |
| `onRequest` | `onRequest(event): number` | Back-compat wrapper: registers a fulfilled-only request interceptor, returns its id. |
| `onResponse` | `onResponse(event): number` | Same for response interceptors. |
| `use` | `use(plugin: { install(client: RequestClientBase): void }): void` | Calls `plugin.install(this)` — a plugin-registration hook with no further contract enforced by this repository. |
| `interceptors` | `readonly interceptors: { request: InterceptorManager<RequestOptions>, response: InterceptorManager<CurlResponse> }` | Public field; consumers call `.use(fulfilled, rejected?, options?)` directly (see Section 5.6). |

### 5.4 `CurlRequest` (`src/request/CurlRequest.ts:15`, extends `RequestClientBase`)

`constructor(opts?: RequestInitOptions, poolOptions?: CurlPoolOptions)`. No additional public members beyond the inherited `BaseClient`/`RequestClientBase` surface. `send()` is `protected`, not part of the public contract.

### 5.5 `CurlRequestMulti` (`src/request/CurlRequestMulti.ts:15`, extends `RequestClientBase`)

| Member | Signature | Contract |
|---|---|---|
| constructor | `constructor(opts?: RequestInitOptions, poolOptions?: CurlPoolOptions, multi?: CurlMultiImpl)` | Optional pre-built `CurlMultiImpl` may be injected; otherwise lazily created on first `send()`. |
| `batch` | `batch(requests: RequestOptions[]): Promise<CurlResponse[]>` | `Promise.all` over per-item `this.request(r)` calls; **fails fast** — if any single request rejects, the whole `batch()` call rejects (standard `Promise.all` semantics), even though other requests may still be in flight on the shared multi handle. |
| `close` | `close(): void` | Overrides base `close()`: calls `this.multi?.close()` **then** `super.close()` (pool close). |

### 5.6 `CurlSession` (`src/request/session.ts:10`, extends `CurlRequest`)

`constructor(ops?: RequestInitOptions, poolOptions?: CurlPoolOptions)`. Identical surface to `CurlRequest`; guarantees `this.opts.jar` is a `CookieJar`.

### 5.7 Legacy `CurlClient` (`src/request/client.ts:85`, extends `CurlRequestImplBase`)

| Member | Signature | Contract |
|---|---|---|
| constructor | `constructor(ops?: CurlOptions)` | See Section 13 for a documented defect in default-option merging. |
| `request` | `override async request(options: RequestOptions): Promise<CurlResponse>` | Per Section 3.9. |
| `onRequest` | `onRequest(event: RequestEvent): void` | Appends to an internal array if not already present (reference-equality dedup, `this.reqs.indexOf(event) === -1`). No return value (unlike `RequestClientBase.onRequest`, which returns a numeric id). |
| `onResponse` | `onResponse(event: ResponseEvent): void` | Same pattern for responses. |
| `close` | `close(): void` | `this.multi?.close()` only — **does not** close any per-request `Curl` handles (they are already closed individually in `beforeResponse()` after each request, since this class never pools handles). |
| `setImpl` / `getImpl` | `setImpl(impl?: CurlMultiImpl): void` / `getImpl(): CurlMultiImpl \| undefined` | Swap or inspect the multi-handle implementation post-construction. |
| `get`/`post`/`put`/`delete`/`patch`/`head`/`options` | inherited from `CurlRequestImplBase` (`src/request/client.ts:26-78`) | Structurally similar to `BaseClient`'s verbs but implemented independently, calling `this.beforeRequest(...)` (which by default just calls `this.request(...)`). |

### 5.8 Standalone function `fetch` (`src/request/request.ts:7`)

`fetch(url: string, options: FetchOptions = {}): Promise<CurlResponse>`. No pooling, no retry, no interceptors, no CORS preflight, no client instance required. `options.body` is copied into `options.data` before dispatch.

### 5.9 `InterceptorManager<T>` (`src/request/interceptors.ts:18`)

| Member | Signature | Contract |
|---|---|---|
| `use` | `use(fulfilled?, rejected?, options?: {runIf?, priority?}): number` | Returns a numeric id usable with `eject`. |
| `eject` | `eject(id: number): void` | Removes one interceptor. |
| `clear` | `clear(): void` | Removes all interceptors on this manager. |
| `runFulfilled` | `runFulfilled(value: T): Promise<T>` | Runs every `fulfilled` handler in priority order (descending `priority`, ties broken by registration order — reversed for `mode === 'request'`, i.e. request interceptors are LIFO within a priority tier, response interceptors are FIFO); each handler only runs if `options.runIf(value)` is absent or `true`; `value` threads through sequentially. |
| `runRejected` | `runRejected(error, value?): Promise<T \| undefined>` | Iterates `rejected` handlers in the same order; the **first** handler whose return value is not `undefined` short-circuits the loop and its return value is used as the recovered value; returns `undefined` if no handler recovers (signaling the caller to re-throw). |

### 5.10 Status and error surface

curl-cffi-node has no custom HTTP status codes of its own (it is a client, not a server) and no custom `Error` subclasses (grep-confirmed zero `extends Error` / custom error classes anywhere in `src/`). The applicable "codes" are:

| Surface | Value space | Where produced |
|---|---|---|
| `CurlResponse.status` | Any HTTP status code returned by the remote server, or `0` if `HttpHeaders.status` cannot regex-match a status line (`src/type/header.ts:41-44`) | `src/helper.ts:parseResponse` via `HttpHeaders.status` |
| Thrown/rejected `Error` (transport failure) | `new Error(call.curl.error(resultCode))` — a human-readable string produced natively from a libcurl result code | `src/impl/curl_multi_timer.ts:122,127`; equivalent logic in `src/impl/curl_multi_event.ts` (unused path) |
| Thrown `Error` (native library not found) | `"Global libs directory not found: ..."` / `"libcurl not found under ...; please run scripts/install.cjs."` | `src/app.ts:42,87` |
| Thrown `Error` (install script misconfigured) | `"libcurl.version not found in libcurl.config.json. Please set { \"version\": \"vX.Y.Z\" }."` | `scripts/install.cjs:16` |
| Rejected `Error` (pool/multi closed mid-flight) | `new Error('CurlPools is closed')` | `src/impl/curl_multi_timer.ts:183`; `src/impl/curl_multi_event.ts:212` |

---

## 6. External Dependencies & Integrations

| Dependency | Version | Type | Purpose | Consumed at |
|---|---|---|---|---|
| `@tocha688/libcurl` | `^0.1.21` (resolved `0.1.21`) | runtime, native N-API addon | Provides `Curl`, `CurlMulti` classes and the `CurlOpt`/`CurlInfo`/`CurlMOpt`/`CurlHttpVersion`/`CurlSslVersion`/`CurlIpResolve`/`CurlWsFlag`/`CurlError` enums; also `globalInit`, `globalCleanup`, `setLibPath`, `getLibPath`, `getVersion`, `socketIsReadable`, `socketIsWritable`. | `src/index.ts`, `src/app.ts`, `src/helper.ts`, `src/impl/*`, `src/core/CurlPool.ts`, `src/request/client.ts`, `src/socket/SocketChecker.ts` |
| `@tocha688/libcurl-<platform>-<arch>[-<libc>]` (11 packages: `android-arm-eabi`, `darwin-arm64`, `darwin-x64`, `freebsd-x64`, `linux-arm-gnueabihf`, `linux-arm64-gnu`, `linux-arm64-musl`, `linux-x64-gnu`, `linux-x64-musl`, `win32-arm64-msvc`, `win32-ia32-msvc`, `win32-x64-msvc`) | `0.1.21` each | runtime, `optionalDependencies` of `@tocha688/libcurl` | Per-platform prebuilt native addon binaries; the package manager installs only the one(s) matching the host, per standard N-API `optionalDependencies` conventions. (`pnpm-lock.yaml:355-427,1457-1506`) |
| `lodash` | `^4.17.21` (dep) + `@types/lodash ^4.17.17` (types) | runtime | Deep `merge`/`clone`/`omit` used throughout option-merging (`src/type/index.ts:20`, `src/request/RequestClientBase.ts:28,35`, `src/request/client.ts:89,147,150`, `src/helper.ts:238,240`, `src/request/shared.ts`). | package-wide |
| `tough-cookie` | `^5.1.2` | runtime | `CookieJar`/`Cookie` classes implementing RFC 6265 cookie storage/matching; consumed as `RequestOptions.jar`. | `src/helper.ts`, `src/request/session.ts`, `src/utils.ts:parseCurlCookies`/`getCookieUrl` |
| `tar` | `^7.4.3` | runtime (used only by the install script, which runs in a Node context, not bundled into `dist/`) | Extracts the downloaded `curl-impersonate` release `.tar.gz` into `libs/<arch>-<platform>_<version>/`. | `scripts/install.cjs:5,155-158` |
| `curl-impersonate` (GitHub project `lexiforest/curl-impersonate`) | version pinned via `libcurl.config.json` (`v1.5.6` at time of writing), auto-updated to the actually-resolved release tag if different | external artifact source, install-time only | Upstream fork of libcurl providing the browser-TLS/HTTP fingerprint-impersonation capability that this whole package exists to expose. | `scripts/install.cjs` (download), `src/app.ts:getLibPath` (runtime load target) |
| GitHub REST API `api.github.com/repos/lexiforest/curl-impersonate/releases` | — | install-time HTTP call | Enumerates releases to find the newest one publishing an asset for the current platform; on failure (network error, non-array response, e.g. rate limiting) falls back to constructing a direct download URL from the configured version. | `scripts/install.cjs:87-136` |
| `curl.se/ca/cacert.pem` | — | install-time HTTP download | Default CA bundle used for TLS verification (`CurlOpt.CaInfo`/`CurlOpt.ProxyCaInfo`) unless `opts.verify === false`. | `scripts/install.cjs:175-179` (download), `src/app.ts:9` (`certPath`), `src/helper.ts:136-137` (usage) |
| `ava` | `^6.0.1` | dev/test | Test runner for `__test__/index.spec.mjs`; configured with `timeout:"3m"`, `workerThreads:false` (`package.json:74-77`). | `package.json:33` (`npm test`) |
| `p-limit` | `^6.2.0` | dev | Bounds concurrency in ad hoc load-test scripts (`tests/pool.ts:1,4`, `tests/pool2.ts:1,5`). | `tests/*.ts` only |
| `tsup` | `^8.5.0` | dev/build | Bundles `src/index.ts` into `dist/`. | `tsup.config.ts`, `package.json:29-31` |
| `typescript` | `^5.8.3` | dev | Type-checking per `tsconfig.json`; actual emit is performed by `tsup`/esbuild, not `tsc` directly (UNVERIFIED whether tsup's `dts: true` invokes `tsc` or a Rust-based type-declaration bundler internally — this is a `tsup` implementation detail out of this repository's control). | build pipeline |

No database, message queue, cache server, or other backing service is used or integrated by this repository.

---

## 7. Configuration Reference

### 7.1 File-based / static configuration

| Key | File | Type | Default | Effect | Consumed at |
|---|---|---|---|---|---|
| `version` | `libcurl.config.json` | string (e.g. `"v1.5.6"`) | none — required; `scripts/install.cjs:16` throws if absent | Pins/records which `curl-impersonate` GitHub release tag to download and prefer at runtime. Self-rewritten by `scripts/install.cjs:updateConfig` (lines 168-173) if the actually-downloaded version differs from the configured one (e.g. GitHub API resolved a newer/older tag). | `scripts/install.cjs:14,42,133-146,163-165`; `src/app.ts:48-49` (runtime preferred-version lookup) |

### 7.2 Programmatic configuration (constructor/call options — this library reads no environment variables; see Section 7.4)

| Key | Type | Default (`defaultRequestOption`, `src/type/index.ts:5-17`) | Effect | Consumed at |
|---|---|---|---|---|
| `method` | `RequestMethod` | `'GET'` | HTTP method. | `src/helper.ts:12-20` |
| `timeout` | `number` (ms) | `30000` | `CurlOpt.TimeoutMs` if `> 0`; `0`/absent disables the timeout. | `src/helper.ts:100-104` |
| `allowRedirects` | `boolean` | `true` | `CurlOpt.FollowLocation`. | `src/helper.ts:113` |
| `maxRedirects` | `number` | `5` | `CurlOpt.MaxRedirs` (see Section 12 item 9 re: the `?? 30` fallback in `helper.ts:114`). | `src/helper.ts:114` |
| `verify` | `boolean` | `true` | `false` disables both `SslVerifyPeer`/`SslVerifyHost`; otherwise enables both and sets `CaInfo`/`ProxyCaInfo` to the bundled cert. | `src/helper.ts:129-138` |
| `acceptEncoding` | `string` | `'gzip, deflate, br, zstd'` | `CurlOpt.AcceptEncoding`. | `src/helper.ts:150-152` |
| `ipType` | `'ipv4'\|'ipv6'\|'auto'` | `'auto'` | `CurlOpt.IpResolve`. | `src/helper.ts:182-194` |
| `defaultHeaders` | `boolean` | `true` | Second argument to `curl.impersonate(profile, defaultHeaders)` — whether the impersonation profile injects its default browser headers. | `src/helper.ts:142` |
| `maxRecvSpeed` | `number` (bytes/s) | `0` (unbounded) | `CurlOpt.MaxRecvSpeedLarge`. | `src/helper.ts:209` |
| `impersonate` | `CURL_IMPERSONATE` union (see `src/type/const.ts`) | `undefined` (commented out in defaults, line 12) | Selects a browser TLS/HTTP fingerprint profile; also gates whether HTTP version is auto-set (Section 3.7 step 14). | `src/helper.ts:141-143,163-167` |
| `proxy` | `string` (`scheme://[user:pass@]host:port`) | `undefined` | `CurlOpt.Proxy` (+`HttpProxyTunnel` for non-SOCKS, +`ProxyUsername`/`ProxyPassword` from URL userinfo). | `src/helper.ts:117-127` |
| `jar` | `CookieJar` | `undefined` | Enables cookie read/write across the request lifecycle. | `src/helper.ts:66-92`, `src/helper.ts:262-266` |
| `retryCount` | `number` | `0` | Number of **additional** attempts after the first failure (i.e. `retryCount: 2` ⇒ up to 3 total attempts). | `src/request/shared.ts:withRetry`; `src/request/client.ts:163-183` (legacy path, separate implementation) |
| `keepAlive` | `boolean` | `undefined` (treated as truthy/default) | `=== false` (and not a CORS preflight) forces `TcpKeepAlive=0` + `FreshConnect=1`, and causes `RequestClientBase` to `pool.remove()` (not `release()`) the handle after use. | `src/helper.ts:197-201`; `src/request/RequestClientBase.ts:85-89` |
| `sync` | `boolean` | `undefined`/`false` | Selects `curl.performSync()` vs `await curl.perform()`. | `src/request/CurlRequest.ts:22`; `src/request/client.ts:128-132`; `src/request/request.ts:12-15` |
| `dev` | `boolean` | `undefined`/`false` | `CurlOpt.Verbose = 1`. | `src/helper.ts:203-207` |
| `cors` | `boolean` | `undefined`/`false` | Triggers a synthetic `OPTIONS` preflight before the real request (client-side simulation only — see Section 9). | `src/request/shared.ts:corsPreflightIfNeeded`; `src/request/client.ts:148-161` |
| `impl` | `CurlMultiImpl` | `undefined` | Pre-built multi-handle transport instance to reuse/inject. | `src/request/CurlRequestMulti.ts` constructor; `src/request/client.ts` (`CurlOptions.impl`) |
| `curlOptions` | `Record<CurlOpt, string\|number\|boolean>` | `undefined` | Arbitrary native-option passthrough not otherwise exposed. | `src/helper.ts:211-224` |

### 7.3 Pool tuning (`CurlPoolOptions`, `src/core/CurlPool.ts:11-14`)

| Key | Type | Default | Effect | Consumed at |
|---|---|---|---|---|
| `maxSize` | `number` | `Number.POSITIVE_INFINITY` | Soft cap on tracked pooled handles; once reached, `acquire()` still returns handles, but they are untracked and closed immediately on `release()` (Section 3.6). | `src/core/CurlPool.ts:30,45` |
| `idleTTL` | `number` (ms) | `60_000` | Idle handles older than this are closed by the periodic `prune()`. | `src/core/CurlPool.ts:31,89` |

### 7.4 Multi-handle tuning — legacy `CurlOptions` only (`src/request/client.ts:112-123`)

| Key | Type | Default | Effect | Consumed at |
|---|---|---|---|---|
| `MaxConnects` | `number` | `10` | `CurlMOpt.MaxConnects` on the legacy `CurlClient`'s multi handle. **Not applied by the modern `CurlRequestMulti`** (see Section 12 item 10). | `src/request/client.ts:121` |
| `MaxConcurrentStreams` | `number` | `500` | `CurlMOpt.MaxConcurrentStreams`, same scope as above. | `src/request/client.ts:122` |

### 7.5 Logging configuration

| Key | Type | Default | Effect | Consumed at |
|---|---|---|---|---|
| `Logger.level` (static property) | `LogLevel` enum (`none=0, error=1, info=2, warn=3, debug=4`) | `LogLevel.info` | Gates which of `Logger.debug/info/warn/error` actually print to `console`. | `src/logger.ts:10`; set externally e.g. `tests/log.ts:3`, `tests/multi.ts:4` |

### 7.6 Environment variables

None. A repository-wide grep for `process.env` returned zero matches in `src/`, `scripts/`, or any config file. All install-time behavior (target platform/arch, target `curl-impersonate` version) is derived from `os.arch()`/`os.platform()` and `libcurl.config.json`, not from environment variables. No secrets/credentials are read from environment variables, `.env` files, or any config file — any credential material (`RequestOptions.auth`, `RequestOptions.proxy` userinfo) must be supplied by the caller at call time and lives only in memory for the duration of the request.

---

## 8. Concurrency, Caching & Performance

1. **Handle pooling, not response caching.** `CurlPool` (`src/core/CurlPool.ts`) reuses native `Curl` easy handles across sequential calls on the same client instance; it does **not** cache HTTP responses — every `request()` call performs a full network transfer. No `Cache-Control`/`ETag`/conditional-request logic exists anywhere in the codebase.
2. **Per-client pool scope.** Each `RequestClientBase` subclass instance (`CurlRequest`, `CurlRequestMulti`, `CurlSession`) owns exactly one `CurlPool` (`src/request/RequestClientBase.ts:30`); pools are not shared across client instances (except indirectly, in that the module-level singleton `req` is one shared client with one shared pool, used by every caller that imports `req` instead of constructing its own client).
3. **Pool overflow is unbounded by default** (`maxSize: Infinity`), so an application issuing many concurrent `CurlRequest`/`CurlSession` calls will allocate one native handle per concurrent in-flight request with no backpressure unless the caller explicitly sets `maxSize`.
4. **Idle pruning** runs on an `unref()`'d native `setInterval` (`src/core/CurlPool.ts:80-81`) so it never keeps the Node process alive by itself; interval period is `min(idleTTL, 60_000)` ms; default `idleTTL` is `60_000` ms.
5. **Multi-handle batching (production path).** `CurlMultiTimer` (`src/impl/curl_multi_timer.ts`) is the actual concurrency engine for `CurlRequestMulti`/`req`: many `request()` calls share one native `CurlMulti` handle and one background processing loop (`waitResult()`), rather than each call blocking on its own OS thread. The loop is guarded by an `isRunning` flag so only one `waitResult()` loop is ever active per `CurlMultiTimer` instance, even though `request()` calls `waitResult()` unconditionally on every invocation (`src/impl/curl_multi_timer.ts:156`).
6. **Blocking-wait granularity.** `waitResult()`'s inner loop calls `await this.wait(10000)` — a native, timeout-bounded multi-wait — meaning the JS event loop yields for up to 10 seconds per iteration if no socket activity or timer fires sooner; this is a coarse polling ceiling, not a busy-loop, but it does mean the transport relies on the native `wait()` call correctly waking up on socket readiness (not independently verifiable from this repository's source — see UNVERIFIED, Section 13).
7. **Unused alternate transport had a tighter design intent.** `CurlMultiEvent` (`src/impl/curl_multi_event.ts`) was designed around per-socket readiness callbacks (`setSocketCallback`) rather than a fixed 10-second poll ceiling, but its supporting `SocketChecker` (`src/socket/SocketChecker.ts`) itself busy-polls each socket file descriptor every 10 ms via `setInterval` calling native `socketIsReadable`/`socketIsWritable` (lines 16-34) — a relatively expensive polling design. This entire path is inactive in the shipped package (not exported from `src/impl/index.ts`).
8. **Concurrency tuning asymmetry.** Native multi-handle concurrency knobs (`CurlMOpt.MaxConnects`, `CurlMOpt.MaxConcurrentStreams`) are only ever set by the legacy `CurlClient.initOptions()` (`src/request/client.ts:121-122`, defaults 10/500); the modern `CurlRequestMulti` never calls `setOption` on its `CurlMultiImpl` at all, so its effective connection/stream concurrency is whatever `@tocha688/libcurl`'s native defaults are (UNVERIFIED — not observable from this repository).
9. **`batch()` fail-fast semantics.** `CurlRequestMulti.batch()` uses `Promise.all`, so one failing request in a batch rejects the entire `batch()` call even though the underlying multi-handle continues processing the other in-flight transfers to completion in the background (their results are simply never awaited by the caller after the `Promise.all` rejection).
10. **No worker threads / no thread pool tuning** is present in this repository's own code for HTTP execution (Node's underlying `libuv` thread pool is used only insofar as the native addon itself may use it — an internal detail of `@tocha688/libcurl`, UNVERIFIED). The project's `ava` test config explicitly disables `workerThreads` (`package.json:76`), an unrelated test-runner setting, not a library runtime setting.
11. **Global singleton reuse.** The module-level `req` (`src/request/index.ts:13`) is a `CurlRequestMulti`, meaning all callers of `req.get/post/...` across an entire process share one connection pool and one multi-handle — this is the intended "performance optimization" path called out in `README.md:156-161` ("Use global interface to reuse connections and improve performance").

---

## 9. Security Model

This library has no authentication/authorization subsystem of its own (it is an outbound HTTP client, not a service with users/sessions/permissions). Security-relevant behavior is limited to transport security and credential passthrough:

1. **TLS verification default-on.** `defaultRequestOption.verify = true` (`src/type/index.ts:10`). When `opts.verify !== false`, `src/helper.ts:129-138` sets `CurlOpt.SslVerifyPeer = 1`, `CurlOpt.SslVerifyHost = 2`, and points `CurlOpt.CaInfo`/`CurlOpt.ProxyCaInfo` at `certPath` (`src/app.ts:9`, `<package_root>/libs/cacert.pem`).
2. **Explicit opt-out disables verification entirely.** `opts.verify === false` sets both `SslVerifyPeer` and `SslVerifyHost` to `0` (`src/helper.ts:130-131`) — full MITM exposure; this is caller-opt-in only, never a library default.
3. **Trust root is a downloaded file, unpinned.** `certPath` is populated at `npm install` time by `scripts/install.cjs:loadCert()` (lines 175-179), which downloads `https://curl.se/ca/cacert.pem` over HTTPS with **no checksum or signature verification** before it is used as the CA trust store for every subsequent verified request. See Section 13 (supply-chain limitation).
4. **Client certificate / mutual-TLS support.** `opts.cert` (string path, or `{cert, key}` paths) maps to `CurlOpt.SslCert`/`CurlOpt.SslKey` (`src/helper.ts:154-160`); whether these native options accept inline PEM content or only filesystem paths is determined entirely by `@tocha688/libcurl`, not by this repository (UNVERIFIED, Section 13).
5. **Basic/negotiated auth passthrough.** `opts.auth.{username, password}` maps directly to `CurlOpt.Username`/`CurlOpt.Password` (`src/helper.ts:96-98`); the specific auth scheme negotiation (Basic/Digest/NTLM/etc.) is delegated entirely to native libcurl — this repository performs no scheme selection or credential encoding of its own.
6. **Proxy credential passthrough.** Proxy userinfo (`http://user:pass@host:port`) is parsed via the WHATWG `URL` class and mapped to `CurlOpt.ProxyUsername`/`CurlOpt.ProxyPassword` (`src/helper.ts:123-126`) — credentials live only in the `opts.proxy` string supplied by the caller for the duration of one call; nothing persists them.
7. **Cookie jar trust boundary.** When `opts.jar` (a `tough-cookie` `CookieJar`) is supplied, cookie domain/path/secure matching is delegated entirely to `tough-cookie`'s own RFC-6265 implementation (`jar.getCookiesSync(url)` / `jar.setCookieSync(cookie, url)`); this repository adds no additional same-origin or cross-site cookie restriction of its own. Redirect-hop `Set-Cookie` values are written into the jar using **each hop's own URL** as the setting origin (`src/helper.ts:262-266`), so a cross-domain redirect chain can result in cookies from multiple distinct origins being written into one shared jar if the jar is reused across origins.
8. **`opts.cors` is not a security boundary.** Setting `cors: true` only causes this client to *issue an extra `OPTIONS` request* before the real one, mimicking browser CORS-preflight wire behavior for fingerprinting/compatibility purposes (`src/request/shared.ts:corsPreflightIfNeeded`, `src/request/client.ts:148-161`). Because this is a server-side HTTP client with no browser sandbox, **no actual cross-origin restriction is enforced** — the real request is still sent regardless of the preflight's outcome; the caller receives whatever response the preflight step returns/discards, but nothing in this library blocks the follow-up request based on preflight results.
9. **Browser fingerprint impersonation is a compatibility feature, not a defensive control.** `opts.impersonate` (`CURL_IMPERSONATE` union, `src/type/const.ts`) changes the outbound TLS ClientHello (JA3) and default header set via the native `curl.impersonate(...)` call (`src/helper.ts:141-143`) to resemble a specific browser/version — its purpose (per `README.md:26-27`, "Bypassing basic anti-bot measures") is evading server-side bot detection, not protecting the calling application.
10. **No secrets are read from environment variables, `.env` files, or persisted config** (Section 7.6) — the only configuration file with any content is `libcurl.config.json`, which holds a public version string, not a credential.
11. **Verbose/debug logging can leak wire data.** `opts.dev = true` enables `CurlOpt.Verbose = 1` (`src/helper.ts:203-207`), causing native libcurl to print raw request/response wire traffic (potentially including headers such as cookies or auth tokens) to its native debug output stream — callers should not enable `dev` in production logging pipelines that capture stdout/stderr.

---

## 10. Build, Deployment & Runtime

### 10.1 Build

- `npm run build` → `tsup` (`tsup.config.ts:3-16`): entry `src/index.ts`; output formats `['esm','cjs']`; `dts: true` (generates `.d.ts`/`.d.mts`); `splitting: true` (code-splitting, applies to the ESM output); `clean: true` (wipes `dist/` first); `platform: "node"`; `shims: true` (Node/ESM interop shims, e.g. for `__dirname`/`import.meta` equivalence).
- `package.json:8-19` `"exports"` map wires both module systems and their type declarations: `import` → `dist/index.mjs` (types `dist/index.d.mts`), `require` → `dist/index.js` (types `dist/index.d.ts`).
- `"main": "dist/index.js"`, `"module": "dist/index.mjs"`, `"types": "dist/index.d.ts"` (`package.json:5-7`) provide fallback resolution for tooling that doesn't read the `exports` map.
- `tsconfig.json` governs type-checking only (`target: ES2020`, `module: CommonJS`, `moduleResolution: node`, `strict: true`, `lib: ["ES2020","DOM"]`, `experimentalDecorators`/`emitDecoratorMetadata: true` though no decorators are used anywhere in `src/` — UNVERIFIED why these are enabled, possibly vestigial); `include: ["src/**/*"]`, `exclude: ["node_modules","dist","tests"]` — `tests/*.ts` are explicitly excluded from the type-checked project.

### 10.2 Publish

- `"prepublishOnly": "npm run build"` (`package.json:31`) guarantees `dist/` is freshly built before `npm publish` runs.
- `"files"` allowlist (`package.json:20-27`): `dist`, `scripts/install.cjs`, `libcurl.config.json`, `README.md`, `README.zh.md`, `LICENSE`. Consequently `src/`, `tests/`, `__test__/`, and `libs/` are **not** included in the published npm tarball.
- `"install": "node scripts/install.cjs"` (`package.json:32`) is an npm lifecycle script that runs automatically on the **consumer's** machine every time the package is installed (both for end users and in CI), not just at publish time.

### 10.3 Install-time native provisioning (`scripts/install.cjs`)

1. Reads `libcurl.config.json` for the target `version`; throws if absent (line 16).
2. `loadLibs()` (lines 87-166): queries the GitHub Releases API for `lexiforest/curl-impersonate`; walks releases newest-first (skipping `prerelease`/`draft`) looking for an asset named `libcurl-impersonate-*<runtimeName>.tar.gz` matching the current platform (`getDirName()`, lines 19-38 — same arch/platform mapping logic as `src/app.ts:getDirName`, independently duplicated); on API failure or no array response, falls back to constructing a direct download URL from the configured `version`.
3. If the target version directory (`libs/<arch>-<platform>_<version>/`) already exists, skips downloading (idempotent install) but still calls `updateConfig()` if the actually-resolved version differs from the configured one.
4. Otherwise downloads the tarball (`downloadFile`, lines 52-85, follows one level of `302` redirect) and extracts it via `tar.x()` into that directory.
5. `loadCert()` (lines 175-179) downloads `https://curl.se/ca/cacert.pem` into `libs/` in parallel with `loadLibs()` (`Promise.all`, lines 183-186).
6. `libs/` is listed in `.gitignore` (line "libs/") — it is never committed to the repository and is always populated fresh by this install step, both in local development and in CI.

### 10.4 Runtime requirements

- Node.js runtime capable of loading a native N-API addon (`@tocha688/libcurl` and its per-platform binary package). No `"engines"` field is present in `package.json` — the minimum supported Node.js version is UNVERIFIED (see Section 13); CI (`10.5`) targets Node 20.
- A writable, loadable filesystem location for `<package_root>/libs/` at install time and a readable one at runtime — deployment targets with a read-only or ephemeral filesystem between install and runtime (e.g. some serverless/container build-then-freeze pipelines that don't preserve `node_modules` writes) would need to ensure `libs/` is included in whatever artifact is actually deployed, since it is populated by a lifecycle script rather than bundled in the npm tarball.
- No listening network port, no daemon process, no server component of any kind — curl-cffi-node is embedded into a host Node.js process and its lifecycle is entirely bound to that process's lifecycle (see Section 3.11 for exit-time cleanup).

### 10.5 CI/CD pipeline (`.github/workflows/npm-publish.yml`)

Triggered on `push` to `main`/`master` (lines 6-8). Four jobs:

1. **`build`** (lines 11-33): `ubuntu-latest`; installs `pnpm@10.6.5`; Node 20 (pnpm-cached); `pnpm install --no-frozen-lockfile`; `pnpm build`; uploads `dist/` as a workflow artifact named `dist`.
2. **`test`** (lines 35-64, `needs: build`): matrix over `[ubuntu-latest, windows-latest, macos-latest]` with `fail-fast: false`; downloads the `dist` artifact; `pnpm install --no-frozen-lockfile`; runs `pnpm test` (→ `ava` against `__test__/index.spec.mjs`, which imports the just-built `dist/index.mjs`).
3. **`check-version`** (lines 66-85): regex-tests the triggering commit message against `^v[0-9]+\.[0-9]+\.[0-9]+$`; sets output `should-publish`.
4. **`publish-npm`** (lines 87-123, `needs: [check-version, build, test]`, conditional on `should-publish == 'true'`): downloads the `dist` artifact; runs `npm publish --access public` against the public npm registry using a `NPM_TOKEN` repository secret (`NODE_AUTH_TOKEN` env var, line 122). A commented-out block (lines 113-117) shows an abandoned intent to auto-bump `package.json`'s version from the commit message — **not active**; the version in `package.json` must already match the tag-style commit message for the publish to make semantic sense (this is not enforced by the workflow itself).

---

## 11. Error Handling, Logging & Observability

1. **Logger** (`src/logger.ts:9-39`): static class, no instances. `LogLevel` enum: `none=0 < error=1 < info=2 < warn=3 < debug=4`. Default `Logger.level = LogLevel.info`. Each method (`info`, `debug`, `warn`, `error`) gates on `this.level >= LogLevel.<method>` and prints via `console.log` (or `console.warn` for `.warn`) prefixed with an ISO-like timestamp (`Logger.time()`, lines 12-14: `new Date().toISOString().replace('T',' ').replace('Z','')`). There is no file sink, remote sink, or structured (JSON) output — console only.
2. **Primary consumers of `Logger`**: `src/impl/curl_multi_timer.ts` and `src/impl/curl_multi_event.ts` use `Logger.debug/warn/error` extensively for multi-handle lifecycle tracing (socket callbacks, timer callbacks, message-drain loop).
3. **Inconsistent logging surface (tech debt).** The legacy `src/request/client.ts:CurlClient.request()` retry loop calls `console.warn(...)` **directly** (line 181) rather than through `Logger`, so its retry messages are not gated by `Logger.level` and cannot be silenced/enabled the same way as the rest of the library's logging.
4. **No custom `Error` subclasses.** A repository-wide search found zero `class ... extends Error` declarations in `src/`. All thrown/rejected errors are plain `new Error(message)`, where `message` is either a static string (native-library-not-found paths in `src/app.ts`) or a native-generated string from `curl.error(resultCode)` (transport failures in `src/impl/curl_multi_timer.ts:122,127` and the unused `src/impl/curl_multi_event.ts` equivalent). Callers cannot branch on an error "code" field — only on message-string content or `instanceof Error`.
5. **Two independent retry implementations**, both count-based with no backoff/jitter:
   - `src/request/shared.ts:withRetry` (lines 99-112) — used by `RequestClientBase.request()` (the modern `CurlRequest`/`CurlRequestMulti`/`CurlSession` path); silent (no logging) on each retry.
   - `src/request/client.ts:CurlClient.request()` inline loop (lines 163-183) — the legacy path; logs each retry via `console.warn`.
   Both retry the **entire** attempt, including `curl.reset()` + `setRequestOptions` + the transfer itself (and, in the legacy path, the CORS preflight is only issued once, before the retry loop, not per-retry — `src/request/client.ts:148-161` runs before the `do {...} while` block starting at line 165).
6. **HTTP error status codes do not reject the returned `Promise`.** `CurlMultiTimer.checkProcess()` (`src/impl/curl_multi_timer.ts:101-141`) only rejects on a native transport failure (`msg.data.result !== 0`) or an implausible status code (`status < 100`, e.g. an empty/unparseable status line); a `404` or `500` response resolves normally with `CurlResponse.status` set accordingly. The same is true of the `src/impl/request_sync.ts` one-shot path, which has no status-code branching at all — it always resolves if the native `perform()`/`performSync()` call itself does not throw. **Callers must check `response.status` explicitly to detect HTTP-level errors.**
7. **Observability.** No metrics library, tracing integration, or health-check endpoint exists anywhere in this repository. The only per-request diagnostic hook is `opts.dev = true` → `CurlOpt.Verbose = 1` (`src/helper.ts:203-207`), which causes the **native** libcurl layer (not this repository's JS code) to emit raw wire-protocol debug output; the exact destination stream is controlled by `@tocha688/libcurl`, not observable from this repository's source (UNVERIFIED, Section 13).
8. **Unhandled-message logging.** `CurlMultiTimer.checkProcess()` logs any drained multi-message that is not `CURLMSG_DONE` via `Logger.warn` (`src/impl/curl_multi_timer.ts:133`) rather than treating it as an error — currently `CURLMSG_DONE (=1)` is the only message type libcurl's multi interface defines besides no-message, so this branch is effectively unreachable under normal libcurl versions (UNVERIFIED whether any libcurl version in use emits other message types).

---

## 12. Invariants & Coupling Map

1. `src/type/index.ts:defaultInitOptions` is mechanically derived from `defaultRequestOption` via `_.omit(defaultRequestOption, ["method","url","params","data"])` (line 20). **Adding a new per-call-only field to `RequestOptions`** (`src/type/request.ts:21`) that should not appear as a client-level default requires also adding it to this omit-list, or it will leak into `RequestInitOptions`'s effective defaults.
2. `src/helper.ts:setRequestOptions` is the **single** place `RequestOptions` fields are translated into native `curl.setOption(...)` calls. **Adding a new field to `RequestOptions`** has zero runtime effect until `setRequestOptions` is also updated to read it — the type system will not catch this, since extra object properties are simply ignored by native option calls that don't reference them. (Concretely, `RequestOptions.ja3`/`RequestOptions.akamai`, `src/type/request.ts:41-42`, currently exist as exactly this kind of unread field — see Section 13.)
3. `src/helper.ts:parseResponse`'s construction of `CurlResponse` (lines 242-250) must stay in sync with `CurlResponseOptions` (`src/type/response.ts:7-16`) and with `CurlResponse`'s own field list (`src/type/response.ts:18-28`) — changing one without the other breaks response construction.
4. **Default-merging is only guaranteed on the modern client path.** `RequestClientBase`'s constructor (`src/request/RequestClientBase.ts:26-28`) *always* computes `this.opts = _.merge({}, defaultInitOptions, opts)`, regardless of whether `opts` was supplied. By contrast, the legacy `CurlClient` constructor (`src/request/client.ts:87-92`) passes the **raw, unmerged** `ops` argument to `super(ops)` (which sets `this.baseOptions = ops` via `CurlRequestImplBase`'s constructor default-parameter, `src/request/client.ts:11-12` — that default parameter, `_.clone(defaultRequestOption)`, only applies when `ops` is `undefined`, i.e. when `new CurlClient()` is called with **no** argument at all). The subsequent line `ops = _.merge({}, defaultRequestOption, ops)` (`src/request/client.ts:89`) reassigns only the local `ops` variable — `this.baseOptions` is never updated to the merged result. **Concretely: `new CurlClient({ timeout: 5000 })` produces a client whose `baseOptions` is exactly `{ timeout: 5000 }`, missing every other `defaultRequestOption` default** (e.g. `verify: true`, `allowRedirects: true`, `acceptEncoding`, `ipType`, `defaultHeaders`, `maxRecvSpeed`), because `request()` (line 147) builds its per-call options via `_.merge({}, this.baseOptions, options)`. Any change intended to fix or rely on consistent default-application across both client families must patch both constructors, or the two families will keep diverging in observable default behavior. (See also Section 13.)
5. `src/impl/index.ts:CurlMultiImpl` is currently a type alias for `CurlMultiTimer` (`export class CurlMultiImpl extends CurlMultiTimer {}`, line 8). Switching this to `CurlMultiEvent` requires first completing that class (its own header comment marks it `"当前模块未完善 不可用"`, `src/impl/curl_multi_event.ts:2`) and exporting it from `src/impl/index.ts` — every consumer (`CurlRequestMulti`, `req`, legacy `CurlClient`) resolves the transport purely through this one alias, so no other file needs to change to swap implementations once `CurlMultiEvent` is production-ready.
6. `src/request/global.ts`'s `storageCurls` registry (attached to `global.__Tocha_CurlStorage`) is the sole mechanism by which native resources are closed on process exit. **Any new class that allocates a native `Curl`/`CurlMulti` handle outside of an existing `CurlPool`/`CurlMultiTimer` must register itself into `storageCurls`** (as done in `src/core/CurlPool.ts:33` and `src/impl/curl_multi_timer.ts:41`) or its handles will leak past `process.on('exit', cleanup)` (`src/request/global.ts:36`). Note: `src/request/client.ts:CurlClient`/`CurlRequestImplBase` does **not** register itself into `storageCurls` at all — its handles are closed per-request in `beforeResponse()` (line 140) instead, but its owned `CurlMultiImpl` (if any, via `ops.impl`) is only closed if the caller explicitly calls `CurlClient.close()`; it is not tracked by the global exit handler.
7. `src/app.ts:getDirName`/`getLibPath` and `scripts/install.cjs:getDirName`/`getLibPath` independently implement the **same** `${arch}-${platform}_${version}` directory-naming convention in two separate files (not shared via a common module). **Changing this naming scheme in one file without mirroring the change in the other** will cause the runtime loader (`src/app.ts`) to fail to find libraries the installer (`scripts/install.cjs`) downloaded, or vice versa.
8. `libcurl.config.json`'s `{"version": "vX.Y.Z"}` shape is read by both `scripts/install.cjs` (lines 13-17, 48-50, 168-173) and `src/app.ts` (lines 46-50) — both readers assume the same top-level `version` key; changing the config file's shape requires updating both readers.
9. `src/type/index.ts:defaultRequestOption.maxRedirects = 5` (line 9) and `src/helper.ts:114`'s independent fallback `opts.maxRedirects ?? 30` disagree (5 vs. 30). Because `setRequestOptions` always spreads `defaultRequestOption` over `opts` first (`src/helper.ts:10`), `maxRedirects` is effectively always `5` unless the caller explicitly overrides it — the `?? 30` branch is normally unreachable. **If `defaultRequestOption.maxRedirects` is ever removed or renamed, the effective default silently changes from 5 to 30** because of this latent, un-synchronized second default. Anyone changing the redirect-limit default must update both locations.
10. `src/request/CurlRequestMulti.ts` never calls `setOption` on its `CurlMultiImpl` instance (no `MaxConnects`/`MaxConcurrentStreams` tuning), while `src/request/client.ts:CurlClient.initOptions()` (lines 112-123) does, for the same underlying `CurlMOpt` options. Porting multi-handle concurrency tuning from the legacy client to the modern one requires adding equivalent logic to `CurlRequestMulti`'s constructor or `multiImpl` getter (`src/request/CurlRequestMulti.ts:23-28`).
11. `src/request/shared.ts:corsPreflightIfNeeded` dynamically `import()`s `../impl/request_sync` at call time specifically to avoid a circular import (comment at line 87-88, "动态导入，避免循环依赖" — "dynamic import, avoids circular dependency"). If `src/impl/request_sync.ts` is ever refactored to import from `src/request/*`, this dynamic-import workaround must be re-evaluated or the circularity it avoids will resurface.
12. `src/core/CurlPool.ts` and `src/impl/curl_multi_timer.ts` both import `storageCurls` directly from `src/request/global.ts` (not through `src/request/index.ts`'s barrel export) — both files carry an explicit comment noting this is deliberate, to avoid pulling in `src/request/session.ts` (and its `CookieJar` dependency chain) through the barrel and creating a circular import. Any refactor of `src/request/index.ts`'s export list must preserve a non-circular import path to `storageCurls` for these two files.

---

## 13. Known Limitations, Tech Debt & UNVERIFIED Items

### 13.1 Verified code defects / tech debt (confirmed by reading the source, not speculative)

- **Legacy `CurlClient` default-merging defect.** `new CurlClient(partialOptions)` does not apply `defaultRequestOption` defaults to `this.baseOptions` when constructed with any defined (even partial) options object — only `new CurlClient()` (no argument) receives full defaults. See Section 12 item 4 for the exact mechanism (`src/request/client.ts:87-92`).
- **`maxRedirects` default mismatch** between `src/type/index.ts:9` (`5`) and `src/helper.ts:114` (`?? 30` fallback) — the second value is normally unreachable dead logic; see Section 12 item 9.
- **`RequestOptions.ja3` and `RequestOptions.akamai`** (`src/type/request.ts:41-42`) are declared in the public type but are **never read** by `src/helper.ts:setRequestOptions` or anywhere else in `src/` (confirmed by search) — these fields currently have no runtime effect if set by a caller, despite appearing in the public `RequestOptions` contract and in `README.md:109-110`.
- **`CurlMultiEvent` (`src/impl/curl_multi_event.ts`) is explicitly marked incomplete** in its own header comment (`"当前模块未完善 不可用"`) and is dead code from the package's public surface — not exported by `src/impl/index.ts`, not referenced by any reachable import path from `src/index.ts`. Its supporting `src/socket/SocketChecker.ts` is likewise only reachable through this dead path.
- **Two parallel, independently-maintained client implementations** coexist by design (`src/request/index.ts:11` comment, "kept to maintain compatibility with existing code"): `BaseClient`/`RequestClientBase`/`CurlRequest`/`CurlRequestMulti`/`CurlSession` vs. `CurlRequestImplBase`/`CurlClient`. They differ in pooling (modern: pooled; legacy: none, closes per request), interceptor model (modern: `InterceptorManager` with priority/`runIf`/error-recovery; legacy: plain ordered arrays with no recovery), retry logging (modern: silent; legacy: `console.warn`), CORS preflight implementation (separate code paths), and default-merging correctness (Section 12 item 4). This doubles the surface area that must be kept behaviorally consistent (or explicitly documented as divergent) for any bugfix that should apply to "the client."
- **Inconsistent logging:** legacy `CurlClient` bypasses `Logger` and calls `console.warn` directly on retry (`src/request/client.ts:181`), making its output ungated by `Logger.level`.
- **`CurlRequestMulti` omits multi-handle concurrency tuning** (`MaxConnects`/`MaxConcurrentStreams`) that the legacy `CurlClient` performs — Section 12 item 10.
- **Install-time downloads have no integrity verification.** `scripts/install.cjs` downloads both the native `curl-impersonate` release tarball and the `curl.se` CA bundle over plain HTTPS with no checksum, signature, or hash-pinning check before extraction/use (`scripts/install.cjs:downloadFile`, `loadLibs`, `loadCert`). A compromised GitHub release asset or a MITM during install (if HTTPS were somehow subverted) would be trusted silently.
- **`src/request/request.ts:fetch`'s `setRequestOptions(curl, options)` call is not awaited** (line 11) — currently harmless because `setRequestOptions` is synchronous, but this is a latent footgun if `setRequestOptions` is ever made `async`.

### 13.2 UNVERIFIED items (could not be confirmed from this repository's source)

> UNVERIFIED: The exact runtime semantics/implementation language of `@tocha688/libcurl`'s native methods (`Curl.perform`, `Curl.performSync`, `Curl.impersonate`, `Curl.setOption`, `Curl.getRespBody`, `Curl.getRespHeaders`, `Curl.id`, `Curl.error`, `CurlMulti.wait`, `CurlMulti.perform`, `CurlMulti.socketAction`, `CurlMulti.infoRead`, `CurlMulti.addHandle`/`removeHandle`, `socketIsReadable`/`socketIsWritable`, `globalInit`/`globalCleanup`, `setLibPath`/`getLibPath`) could not be confirmed — this repository's `node_modules` was not installed in the environment used to produce this document, and `@tocha688/libcurl`'s own source is an external package not vendored into this repository. Only call sites and observed argument/callback shapes within curl-cffi-node itself are documented here (Sections 1, 3, 8).

> UNVERIFIED: Minimum supported Node.js version. `package.json` has no `"engines"` field. CI (`​.github/workflows/npm-publish.yml`) uses Node 20, but this is only confirmed as the CI-tested version, not a documented minimum.

> UNVERIFIED: Whether `tests/*.ts` ad hoc scripts are intended to be executed via Bun (a `bun.lock` file is present at the repository root) or via `ts-node`/`tsx`/direct `tsc` compilation. No `package.json` script, CI step, or config file wires any of `tests/*.ts` into automated execution; they appear to be manually-run, live-network integration/exploration scripts (several hit real hosts like `httpbin.org`, `tls.peet.ws`, `ipinfo.thordata.com`, `www.google.com`).

> UNVERIFIED: The exact destination stream and format of libcurl's native verbose/debug output when `RequestOptions.dev = true` sets `CurlOpt.Verbose = 1` (`src/helper.ts:203-207`) — this is controlled entirely by the native binding, not by any code in this repository.

> UNVERIFIED: Whether `CurlOpt.SslCert`/`CurlOpt.SslKey` (`src/helper.ts:155-160`) accept inline PEM string content or require filesystem paths — determined by `@tocha688/libcurl`'s native option handling, not observable from this repository's source.

> UNVERIFIED: Whether `README.zh.md` is a complete, currently-accurate translation of `README.md`, or has drifted — only the opening sections of both files were compared for structural correspondence; a full line-by-line diff was not performed.

> UNVERIFIED: Why `tsconfig.json` enables `experimentalDecorators`/`emitDecoratorMetadata` (lines 14-15) when no decorator syntax was found anywhere in `src/` during this review — possibly vestigial configuration from an earlier stage of the project.

> UNVERIFIED: Whether any libcurl version actually in use by `@tocha688/libcurl` ever emits a multi-interface message other than `CURLMSG_DONE`, which would exercise the `Logger.warn` branch at `src/impl/curl_multi_timer.ts:133` (see Section 11 item 8).

### 13.3 Collated `> ASSUMPTION:` decisions made while producing this document

> ASSUMPTION: Application name documented as **curl-cffi-node** (GitHub repository identity), distinct from the published npm package name `curl-cffi` (`package.json:2`), to disambiguate from the upstream Python `curl_cffi` project and the `@tocha688/libcurl` native dependency. Filename slug derived as `curl_cffi_node`.

> ASSUMPTION: This document treats curl-cffi-node purely as an embeddable library. Section 4 ("Data Model") documents in-memory value objects/pool state rather than a database schema, and Section 5 ("Interfaces & APIs") documents the public exported class/function contracts rather than HTTP server routes, since this repository defines no server and no persistent store of its own.

> ASSUMPTION: "Primary operations" for Section 3 were chosen as: library bootstrap, single async request (`CurlRequest`), single sync request, session request (`CurlSession`), batch/multi request (`CurlRequestMulti`), pool acquire/release lifecycle, the `setRequestOptions`/`parseResponse` transformation pair, the legacy `CurlClient` flow, the standalone `fetch()` function, and process-exit cleanup — selected because each represents a materially distinct code path a maintaining reader would need to trace independently, rather than variations of the same path.

> ASSUMPTION: Section 9 ("Security Model") omits any authentication/authorization-flow subsection, since this library implements no login, session, or permission system of its own; only transport-layer security (TLS verification, certificates, proxy/basic-auth credential passthrough, cookie jar behavior) is in scope, consistent with this being an HTTP client library rather than a service.

> ASSUMPTION: `README.zh.md` is treated as a Chinese translation counterpart of `README.md` based on matching top-level structure observed in both files' opening sections, without a full line-by-line verification (also listed as UNVERIFIED above for precision).
