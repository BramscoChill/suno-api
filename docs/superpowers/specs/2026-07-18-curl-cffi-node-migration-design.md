# Migrate SunoApi.ts request transport from axios to curl-cffi-node

## Purpose

Replace axios as the HTTP transport used to talk to Suno/Clerk with `curl-cffi-node`
(npm package `curl-cffi`), as documented in `docs/curl_cffi_node_TECHNICAL_REFERENCE.md`.
The motivation is `curl-cffi-node`'s TLS/HTTP browser-fingerprint impersonation
(`curl.impersonate(...)`), which is directly relevant to this project's ongoing fight
against Suno's Cloudflare/captcha bot detection (see recent commits "new captcha
detection logic", "suno updated website, made it working again").

Every outgoing request must go through the new client — no request should be left on
the old transport.

## Scope

- `src/lib/SunoApi.ts` — the only file in `src/` that uses axios. All HTTP calls to
  Suno/Clerk are centralized behind the single `this.client` instance in this file.
- `package.json` — drop `axios` as a direct dependency, add `curl-cffi`.
- Out of scope: `axios` remains transitively present in `node_modules` via
  `swagger-ui-react`'s own dependency tree; that is unrelated and untouched.
- Out of scope: `generateSongViaBrowser` and the Playwright browser-automation
  captcha-bypass path do not use `this.client` / axios at all and are unaffected.

## Architecture

### Client construction

Replace:
```ts
this.client = axios.create({ withCredentials: true, headers: {...} });
```
with:
```ts
this.client = new CurlSession({
  impersonate: <a Chromium/Android-flavored CURL_IMPERSONATE profile, picked after
               inspecting the installed package's actual profile union>,
  defaultHeaders: false,
  headers: { ...same custom headers as today... }
});
```

`CurlSession` auto-provisions a `tough-cookie` `CookieJar` (`this.client.jar`). Immediately
after construction, seed that jar from the cookies already parsed out of the incoming
`Cookie` string (`cookie.parse(cookies)`), writing each as a `Domain=.suno.com` cookie via
`jar.setCookieSync(...)`. Raw `Cookie:` header strings carry no domain/path attributes, so
this is the only way to reproduce today's behavior of resending every known cookie to every
Suno host used (`studio-api.prod.suno.com`, `auth.suno.com`) rather than having them become
host-only for whichever domain happens to see them first.

### Interceptors

- Delete the current request interceptor that manually serializes `this.cookies` into a
  `Cookie` header, and the response interceptor that manually parses `Set-Cookie` back into
  `this.cookies`. With a jar attached, curl-cffi-node's `setRequestOptions`/`parseResponse`
  handle both directions automatically on every request/response.
- Keep one request interceptor: inject `Authorization: Bearer <token>` only if the
  per-call options didn't already set an `Authorization` header. This preserves the existing
  override used by `getAuthToken`/`keepAlive`, which pass the Clerk client token explicitly
  via per-call `headers`.
- Add one response interceptor that throws when `status` is outside the 200-299 range. This
  is a single choke point that reproduces axios's default `validateStatus` throw-on-error
  behavior — curl-cffi-node itself never rejects for HTTP error statuses, only for
  transport-level failures. This replaces the ad hoc `if (response.status !== 200) throw ...`
  blocks in `concatenate`, the main `generateSongs` POST, `getFeed`, and
  `getPersonaPaginated` (all now redundant, removed), and additionally covers the methods
  that never had a check at all (`keepAlive`, `generateLyrics`, `get`, `getClip`,
  `get_credits`) — those previously relied on axios's implicit throw and would otherwise
  silently proceed on a 4xx/5xx captcha/error page.

### Call sites

`BaseClient.get(url, options)` / `.post(url, data, options)` match axios's signature, so
call sites need minimal changes. `response.data` and `response.status` are used the same
way. `response.statusText` does not exist on `CurlResponse` — the few remaining manual
error-message constructions that reference it are simplified away now that the response
interceptor already throws before those lines would ever see a non-2xx response.

### Known, accepted behavior changes

- Errors thrown by curl-cffi-node (both the new response interceptor and native
  transport-failure errors) are plain `Error` objects with no `.code` property. Existing
  catch sites that log `error?.code ?? error?.message` will now always fall through to
  `.message`. This is a cosmetic logging difference only, not a functional one.
- Cookies received via `Set-Cookie` after this migration are absorbed into the jar using
  standard `tough-cookie` domain-matching rules (host-only unless the server's `Set-Cookie`
  specifies a `Domain` attribute), rather than today's "merge everything into one flat map,
  resend to every host" approach. This is more correct per real cookie semantics and is not
  expected to change behavior in practice, since the two hosts involved
  (`studio-api.prod.suno.com`, `auth.suno.com`) don't currently appear to depend on sharing
  session cookies between each other.

## Testing / Verification

No unit tests exist today for `SunoApi.ts`. Verification consists of:
- `next build` / TypeScript compilation succeeding.
- A manual smoke test against the live Suno API if a working `SUNO_COOKIE` is available in
  this environment.
- If no valid session cookie is available, live verification is flagged as needing to
  happen on the user's end, since it depends on a currently-valid Suno session.
