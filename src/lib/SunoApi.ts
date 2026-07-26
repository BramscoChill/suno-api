import { CurlSession } from 'curl-cffi';
import pino from 'pino';
import yn from 'yn';
import { sleep } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { generateSongViaBrowser } from '@/lib/CaptchaBrowser';
import { promises as fs } from 'fs';
import path from 'node:path';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-fenix'; //'chirp-v3-5';

export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any; // You can define a more specific type if needed
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any; // You can define a more specific type if needed
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';
  /**
   * Browser identity for the HTTP transport, pinned to **146** so it agrees with the `chrome146`
   * TLS profile used below. Derived from a real Brave / Windows session on suno.com, with the
   * version numbers moved 150 -> 146; Brave is Chromium, so its UA reports `Chrome/<n>.0.0.0` and
   * its TLS fingerprint is Chrome's.
   *
   * NOTE: this no longer matches the captcha browser. CloakBrowser ships a newer Chromium (150 on
   * a registered licence) and reports its own real UA, while curl-cffi 0.1.50 has no `chrome150`
   * TLS profile. Pinning this string forward without a matching profile would make the UA and the
   * JA3 fingerprint disagree *within the same connection*, which is a stronger signal than the
   * API and browser paths differing — so the pair stays at 146. `CaptchaBrowser` logs the split
   * on every browser run (see `checkUserAgentDrift`), and `CLOAKBROWSER_VERSION` can pin the
   * binary back to 146 if exact parity is ever wanted.
   */
  private static USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

  /**
   * Canonical HTTP/2 header order for a Chromium `fetch()`/XHR, measured from a real Chromium
   * against a local h2 server (see `docs/suno_api_FINGERPRINT_MATCHING_GUIDE.md` §4). Header
   * order is itself a fingerprint, and curl emits our headers in object-literal order, so the
   * outgoing set is re-sorted into this order on every request.
   *
   * `'*'` is the slot where Chrome emits headers supplied by the caller of `fetch()` — measured:
   * a fetch-supplied `content-type` lands between `sec-ch-ua` and `sec-ch-ua-mobile`. Suno's own
   * app headers plus `Authorization` are exactly that kind of header, so they go there too.
   *
   * `cookie` is absent on purpose: libcurl generates it from the cookie jar and controls its
   * position itself (Chrome emits it between `accept-encoding` and `priority`).
   */
  private static readonly HEADER_ORDER = [
    'sec-ch-ua-platform',
    'user-agent',
    'sec-ch-ua',
    '*',
    'accept-language',
    'sec-ch-ua-mobile',
    'accept',
    'origin',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
    'sec-gpc',
    'referer',
    'accept-encoding',
    'priority'
  ];

  /** Rebuild a header map in `HEADER_ORDER`. Keys are lower-cased, which is what goes over the
   *  wire on HTTP/2 anyway. Unknown headers fall into the `'*'` (author-supplied) slot. */
  private static orderHeaders(headers: Record<string, string>): Record<string, string> {
    const remaining = new Map(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v] as const)
    );
    const ordered: Record<string, string> = {};
    for (const slot of SunoApi.HEADER_ORDER) {
      if (slot === '*') {
        for (const [key, value] of Array.from(remaining)) {
          if (SunoApi.HEADER_ORDER.includes(key)) continue;
          ordered[key] = value;
          remaining.delete(key);
        }
        continue;
      }
      if (remaining.has(slot)) {
        ordered[slot] = remaining.get(slot)!;
        remaining.delete(slot);
      }
    }
    for (const [key, value] of remaining) ordered[key] = value;
    return ordered;
  }

  private readonly client: CurlSession;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;

  constructor(cookies: string) {
    this.userAgent = SunoApi.USER_AGENT;
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = new CurlSession({
      // Brave is Chromium-based, so its TLS/HTTP2 fingerprint is Chrome's. curl-cffi 0.1.50 has
      // no chrome150 profile — `chrome146` is the newest desktop Chrome in the installed
      // CURL_IMPERSONATE_CHROME union, and every version number in the headers below is pinned to
      // 146 to match it. See docs/suno_api_FINGERPRINT_MATCHING_GUIDE.md for how to build a real
      // chrome150 target.
      impersonate: 'chrome146',
      // Suppress the profile's own canned header set (it describes a top-level *navigation*:
      // `sec-fetch-mode: navigate`, `accept: text/html,...`). Every header below is sent verbatim
      // instead, shaped like the XHR/fetch requests the Suno web client actually makes.
      defaultHeaders: false,
      // Order here is documentation only — `orderHeaders` re-sorts on every request (see the
      // interceptor below), because per-request headers would otherwise be appended at the end.
      headers: SunoApi.orderHeaders({
        // --- browser identity, from a real Brave / Windows request to suno.com, pinned to v146 ---
        'sec-ch-ua-platform': '"Windows"',
        'user-agent': this.userAgent,
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="146", "Brave";v="146"',
        // DO NOT "correct" this to Chromium's `en-GB,en-US;q=0.9,en;q=0.8` ladder. This value was
        // captured from the operator's real Brave (see the provenance on this block): Brave reduces
        // Accept-Language as a fingerprinting defence and emits a two-entry `q=0.5` ladder where
        // stock Chromium emits a descending three-entry one. Measured for contrast in
        // docs/fingerprint-tools/verify-locale-header.mjs — `--lang=en-GB` on the captcha browser
        // gives `en-GB,en-US;q=0.9,en;q=0.8`. So the two paths legitimately differ in ladder while
        // agreeing on the primary tag (en-GB), which is the part a coarse correlation keys on; see
        // §3.6 of the technical reference. Re-capture with docs/fingerprint-tools/brave-capture.js
        // if the provenance is ever in doubt.
        'accept-language': 'en-GB,en;q=0.5',
        'sec-ch-ua-mobile': '?0',
        accept: '*/*',
        origin: 'https://suno.com',
        // Both API hosts (auth.suno.com, studio-api.prod.suno.com) are same-site w.r.t. suno.com.
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'sec-gpc': '1',
        referer: 'https://suno.com/',
        // Must be listed explicitly to land in Chrome's position — libcurl otherwise emits its
        // own `accept-encoding` first, ahead of every custom header. The `acceptEncoding` request
        // option is deliberately left at its default ("gzip, deflate, br, zstd", identical to the
        // real browser) because that option, not this header, is what makes libcurl actually
        // decompress the response body. Measured: option default + this header = right position
        // AND decompression; clearing the option = raw gzip bytes.
        'accept-encoding': 'gzip, deflate, br, zstd',
        priority: 'u=1, i',
        // --- Suno application headers (the web client sends these to studio-api too) ---
        'affiliate-id': 'undefined',
        'device-id': `"${this.deviceId}"`,
        'browser-token': `{"token":"${Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64')}"}`
      })
    });
    // Raw `Cookie:` header strings carry no domain/path attributes, so seed the jar with an
    // explicit `Domain=.suno.com` for every known cookie. This reproduces the old behavior of
    // resending every cookie to every Suno host (studio-api.prod.suno.com, auth.suno.com)
    // instead of letting them become host-only for whichever domain sees them first.
    for (const [key, value] of Object.entries(this.cookies)) {
      if (value === undefined) continue;
      this.client.jar?.setCookieSync(
        `${cookie.serialize(key, value)}; Domain=.suno.com; Path=/`,
        'https://suno.com/'
      );
    }
    // Bearer-token injection and header re-ordering share one interceptor on purpose: curl-cffi
    // runs *request* interceptors last-registered-first (InterceptorManager.list() reverses for
    // mode 'request'), so splitting these in two would run the re-order before the token was
    // added and leave `authorization` appended at the very end of the header block.
    this.client.onRequest(opts => {
      const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
      const hasAuth = Object.keys(headers).some(k => k.toLowerCase() === 'authorization');
      if (this.currentToken && !hasAuth) {
        headers.authorization = `Bearer ${this.currentToken}`;
      }
      // Per-request headers (Content-Type, Authorization, ...) are deep-merged onto the session
      // headers by curl-cffi and land at the end of the object; re-sort so they sit where Chrome
      // puts caller-supplied fetch headers instead.
      opts.headers = SunoApi.orderHeaders(headers);
      return opts;
    });
    // curl-cffi-node never rejects for HTTP error statuses (only transport-level failures), so
    // this is the single choke point reproducing axios's default validateStatus throw-on-error.
    this.client.onResponse(resp => {
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Request failed with status code ${resp.status}`);
      }
      return resp;
    });
  }

  public async init(): Promise<SunoApi> {
    //await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    logger.info('Getting the session ID');
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client! }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE'
      );
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;
    // Renew session token
    logger.info('KeepAlive...\n');
    const renewResponse = await this.client.post(renewUrl, {}, {
      headers: { Authorization: this.cookies.__client! }
    });
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data.jwt;
    // Update Authorization field in request header with the new JWT token
    this.currentToken = newToken;
  }

  /**
   * Get the session token (not to be confused with session ID) and save it for later use.
   */
  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private async captchaRequired(): Promise<boolean> {
    // Suno's edge (Cloudflare) intermittently resets the connection on this
    // endpoint (ECONNRESET), so retry a few times with backoff. If the check
    // ultimately fails, assume a captcha IS required and let the captcha flow
    // handle it rather than aborting the whole request.
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
          ctype: 'generation'
        });
        logger.info(resp.data);
        return resp.data.required;
      } catch (error: any) {
        if (attempt === maxAttempts) {
          logger.warn(
            `captcha check failed (${error?.code ?? error?.message}); assuming a captcha is required`
          );
          return true;
        }
        logger.warn(
          `captcha check failed with ${error?.code ?? error?.message} (attempt ${attempt}/${maxAttempts}), retrying...`
        );
        await sleep(1, 3);
      }
    }
    return true;
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio
    );
    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000 // 10 seconds timeout
      }
    );
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags
    );
    const costTime = Date.now() - startTime;
    logger.info(
      'Custom Generate Response:\n' + JSON.stringify(audios, null, 2)
    );
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @param task Optional indication of what to do. Enter 'extend' if extending an audio, otherwise specify null.
   * @param continue_clip_id 
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number
  ): Promise<AudioInfo[]> {
    await this.keepAlive();
    let clips: any[];

    if (await this.captchaRequired()) {
      const browserResult = await generateSongViaBrowser({
        prompt,
        tags,
        cookies: this.cookies,
        sessionToken: this.currentToken ?? '',
        expectedUserAgent: this.userAgent
      });
      clips = browserResult.clips;
    } else {
      const payload: any = {
        make_instrumental: make_instrumental,
        mv: model || DEFAULT_MODEL,
        prompt: '',
        generation_type: 'TEXT',
        continue_at: continue_at,
        continue_clip_id: continue_clip_id,
        task: task,
        token: null
      };
      if (isCustom) {
        payload.tags = tags;
        payload.title = title;
        payload.negative_tags = negative_tags;
        payload.prompt = prompt;
      } else {
        payload.gpt_description_prompt = prompt;
      }
      logger.info(
        'generateSongs payload:\n' +
          JSON.stringify(
            {
              prompt: prompt,
              isCustom: isCustom,
              tags: tags,
              title: title,
              make_instrumental: make_instrumental,
              wait_audio: wait_audio,
              negative_tags: negative_tags,
              payload: payload
            },
            null,
            2
          )
      );
      const response = await this.client.post(
        `${SunoApi.BASE_URL}/api/generate/v2-web/`,
        payload,
        {
          timeout: 10000 // 10 seconds timeout
        }
      );
      clips = response.data.clips;
    }

    const songIds = clips.map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   *
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt);
  }

  /**
   * Generate stems for a song.
   * @param song_id The ID of the song to generate stems for.
   * @returns A promise that resolves to an AudioInfo object representing the generated stems.
   */
  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );

    console.log('generateStems response:\n', response?.data);
    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }


  /**
   * Get the lyric alignment for a song.
   * @param song_id The ID of the song to get the lyric alignment for.
   * @returns A promise that resolves to an object containing the lyric alignment.
   */
  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`);

    console.log(`getLyricAlignment ~ response:`, response.data);
    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  /**
   * Get the WAV file download info for a song.
   * @param song_id The ID of the song to get the WAV file for.
   * @returns A promise that resolves to the WAV file response data.
   */
  public async getWavFile(song_id: string): Promise<any> {
    await this.keepAlive(false);
    
    await this.client.post(
      `${SunoApi.BASE_URL}/api/gen/${song_id}/increment_play_count/v2`,
      { sample_factor: 1 },
      { headers: { 'Content-Type': 'application/json' } }
    );
    
    let delayMs = 1000 + Math.random() * 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    await this.client.post(`${SunoApi.BASE_URL}/api/gen/${song_id}/downbeats_streaming/v2`, undefined, {
      headers: { 'Content-Type': 'application/json' },
    });

    delayMs = 1000 + Math.random() * 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    await this.client.post(`${SunoApi.BASE_URL}/api/gen/${song_id}/convert_wav/`, undefined, {
      headers: { 'Content-Type': 'application/json' },
    });

    delayMs = 2000 + Math.random() * 3000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const response = await this.client.get(`${SunoApi.BASE_URL}/api/gen/${song_id}/wav_file/`);

    console.log(`getWavFile ~ response:`, response.data);
    return response.data;
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @param page An optional page number to retrieve audio information from.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);

    // Suno removed the old `/api/feed/v2` endpoint (it now 404s). Two successors replace it:
    //   - by-ids:  fetch each clip via `/api/clip/{id}` (the batch `/api/clips/get_songs_by_ids`
    //              only ever honors the last `ids=` value, so it can't be used for multiple ids)
    //   - no-ids:  the cursor-based `/api/feed/v3` (POST) library feed
    // Both return the same clip shape (`audio.metadata.*`) the old feed did, so the mapping below
    // is shared. As before, ids that don't resolve are simply omitted from the result.
    let clips: any[];
    if (songIds && songIds.length > 0) {
      logger.info('Get audio status for ids: ' + songIds.join(','));
      const fetched = await Promise.all(
        songIds.map(async (id) => {
          try {
            const response = await this.client.get(
              `${SunoApi.BASE_URL}/api/clip/${id}`,
              { timeout: 10000 }
            );
            return response.data;
          } catch (error) {
            logger.warn(`Failed to fetch clip ${id}: ${(error as Error).message}`);
            return null;
          }
        })
      );
      clips = fetched.filter((clip) => clip != null);
    } else {
      // `page`, when provided, is treated as the opaque feed cursor (v3 is cursor-based, not
      // page-numbered). Without it, the first page of the default workspace feed is returned.
      const payload: any = {
        cursor: page ?? null,
        limit: 20,
        filters: {
          liked: 'False',
          trashed: 'False',
          fromStudioProject: { presence: 'False' },
          stem: { presence: 'False' },
          workspace: { presence: 'True', workspaceId: 'default' }
        }
      };
      logger.info('Get audio feed (no ids)');
      const response = await this.client.post(
        `${SunoApi.BASE_URL}/api/feed/v3`,
        payload,
        { timeout: 10000 }
      );
      clips = response.data.clips ?? [];
    }

    return clips.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata?.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata?.gpt_description_prompt,
      prompt: audio.metadata?.prompt,
      type: audio.metadata?.type,
      tags: audio.metadata?.tags,
      duration: audio.metadata?.duration,
      error_message: audio.metadata?.error_message
    }));
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }


  public async getFeed(nextCursorId: string | null, liked: boolean | false, trashed: boolean | false): Promise<object> {
    await this.keepAlive(false);

    const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);


    const payload: any = {
      cursor: !!nextCursorId ? nextCursorId : null,
      limit: 20,
      filters: {
        liked: liked != null ? capitalize(String(liked)) : "False",
        trashed: trashed != null ? capitalize(String(trashed)) : "False",
        fromStudioProject: { presence: "False" },
        stem: { presence: "False" },
        workspace: { presence: "True", workspaceId: "default" }
      }
    };

      const response = await this.client.post(
        `${SunoApi.BASE_URL}/api/feed/v3`,
        payload,
        {
          timeout: 10000 // 10 seconds timeout
        }
      );

    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);
    
    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;
    
    logger.info(`Fetching persona data: ${url}`);
    
    const response = await this.client.get(url, {
      timeout: 10000 // 10 seconds timeout
    });

    return response.data;
  }
}

export const sunoApi = async (cookie?: string) => {
  const resolvedCookie = cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE; // Check for bad `Cookie` header (It's too expensive to actually parse the cookies *here*)
  if (!resolvedCookie) {
    logger.info('No cookie provided! Aborting...\nPlease provide a cookie either in the .env file or in the Cookie header of your request.')
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }

  // Check if the instance for this cookie already exists in the cache
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance)
    return cachedInstance;

  // If not, create a new instance and initialize it
  const instance = await new SunoApi(resolvedCookie).init();
  // Cache the initialized instance
  cache.set(resolvedCookie, instance);

  return instance;
};