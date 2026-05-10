/**
 * src/ranking/filters/noise-patterns.ts — P1 W3 cleanup wedge.
 *
 * Pure-`RegExp` constants extracted byte-identical from
 * `src/execution/index.ts:rankEndpoints` filter preamble (was at
 * L3411-3431). They describe what is NOT data — endpoints that should
 * never reach the scoring pipeline because they're tracking pixels,
 * i18n locales, auth scaffolding, session plumbing, static assets, or
 * UI animation paths.
 *
 * This module is the negative-space companion to `src/ranking/signals/`:
 *   - `signals/`  — what counts (positive scoring contributions)
 *   - `filters/`  — what doesn't (drop before scoring)
 *
 * Origin: PAPER_PLAN.md §P1 "delete inline scoring deltas" naturally
 * extends to "delete inline filter constants" — the filter preamble's
 * `if (REGEX.test(...)) return false;` chain is morally a -∞ score
 * delta. Lifting these constants out reduces rankEndpoints cognitive
 * load without changing behavior.
 *
 * Parity contract: tests/ranking-parity.test.ts holds the byte-identical
 * baseline. Any change to these patterns MUST update the parity baseline
 * in the same commit, with a CHANGELOG entry naming what changed.
 *
 * Inoculation #2 binds: the regex contents were tuned against real
 * captured traffic; do not adjust without a reproducible benchmark.
 *
 * Cluster discipline: SESSION_PLUMBING is also referenced from the
 * scoring body at `src/execution/index.ts` (a -350 penalty on session-
 * bound URL templates). Both call sites import this same constant; a
 * future loop that wants to diverge filter-vs-scoring semantics would
 * split into two named regexes here.
 */

/** Hosts that are pure noise — tracking, telemetry, auth providers, CDN trackers, etc. */
export const NOISE_HOSTS = /(id5-sync\.com|btloader\.com|presage\.io|onetrust\.com|adsrvr\.org|googlesyndication\.com|adtrafficquality\.google|amazon-adsystem\.com|crazyegg\.com|challenges\.cloudflare\.com|google-analytics\.com|doubleclick\.net|gstatic\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|protechts\.net|demdex\.net|datadoghq\.com|fullstory\.com|launchdarkly\.com|intercom\.io|sentry\.io|segment\.io|amplitude\.com|mixpanel\.com|hotjar\.com|clarity\.ms|googletagmanager\.com|walletconnect\.com|cloudflareinsights\.com|fonts\.googleapis\.com|recaptcha|waa-pa\.|signaler-pa\.|ogads-pa\.|reddit\.com\/pixels?|pixel-config\.|dns-finder\.com|cookieconsentpub|firebase\.googleapis\.com|firebaseinstallations\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|apis\.google\.com|connect\.facebook\.net|bat\.bing\.com|static\.cloudflareinsights\.com|cdn\.mxpnl\.com|js\.hs-analytics\.net|snap\.licdn\.com|clc\.stackoverflow\.com|px\.ads|t\.co\/i|analytics\.|telemetry\.|stats\.)/i;

/** Noise URL path patterns — tracking, telemetry, logging. */
export const NOISE_PATHS = /\/(track|pixel|telemetry|beacon|csp-report|litms|demdex|analytics|protechts|collect|tr\/|gen_204|generate_204|log$|logging|heartbeat|metrics|consent|sodar|tag$|event$|events$|impression|pageview|click|__|adx\/|\/cm\/ttc|\/pfb$|_stm$|videoads\/|prerolls|phantom\/)/i;

/** i18n / locales / static config — translation files and navigation scaffolding, never data. */
export const I18N_CONFIG_PATHS = /\/(i18n\/|locales\/|locale\/|translations?\/|l10n\/|lang\/[a-z]{2,5}\/|navigation\.json$|privacy[-_]compliance|privacy[-_]consent|consent[-_])/i;

/** Auth/session/config — on-domain but not data. */
export const AUTH_CONFIG_PATHS = /\/(csrf_meta|logged_in_user|analytics_user_data|onboarding|geolocation|auth|login|logout|register|signup|session|webConfig|config\.json|manifest\.json|robots\.txt|sitemap|favicon|opensearch|service-worker|sw\.js)\b/i;

/**
 * Session plumbing — infrastructure endpoints no user would ever want as data.
 * Only true noise: account config, badge counts, feature flags, telemetry, DM settings.
 * NOT filtered: HomeTimeline, Bookmarks, Notifications, UserByScreenName, etc. — real data.
 */
export const SESSION_PLUMBING = /(account\/settings|account\/multi|badge_count|DataSaverMode|permissionsState|email_phone_info|live_pipeline|user_flow|strato\/column|ces\/p2|IntercomStarter|getAltText|fleetline|FeatureHelper|VerifiedAvatar|ScheduledPromotion|DirectCall|DmSettings|PinnedTimeline)/i;

/** Static assets — fonts, scripts, images, media, fonts, web-binary. */
export const STATIC_ASSET_PATTERNS = /\.(woff2?|ttf|eot|css|js|mjs|png|jpg|jpeg|gif|svg|ico|webp|avif|mp4|mp3|wav|riv|lottie|wasm)(\?|%3F|$)/i;

/** Animation / UI asset paths. */
export const UI_ASSET_PATHS = /\/(rive|lottie|animations?|sprites?|assets\/static)\//i;
