/**
 * Turning a pile of backend failures into a conclusion.
 *
 * The tried-list now says what each backend did, which was a large
 * improvement over saying nothing. But reading six notes and inferring "my
 * egress address is bot-flagged" is work we can do for the operator, and it
 * is the difference between a diagnostic and a diagnosis. The distinctions
 * that matter, because each has a different fix:
 *
 *   - unavailable   — the video itself is gone, private or region-locked.
 *                     Nothing on our side is broken and nothing fixes it.
 *   - bot wall      — YouTube named us. Nothing in extraction fixes this.
 *   - gated         — a 200 with the formats withheld. Proof-of-origin.
 *   - no route      — this machine cannot reach the internet.
 *   - upstream sick — third-party instances are down; not about us at all.
 *
 * The order of checks is deliberate: a bot wall outranks everything, because
 * when it is present the other failures are usually consequences of it rather
 * than independent problems.
 */

const BOT = /sign ?in to confirm|not a bot|LOGIN_REQUIRED|CONSENT_WALL|consent wall|confirm you'?re|age.?restrict/i;
const GATED = /no playable formats|no formats|formats were withheld|empty format|streamingData/i;
/* YouTube saying the video is gone is not a diagnosis of us. It outranks
   everything else, because an unavailable video produces exactly the same
   empty format lists as a gate — and sending someone off to mint a
   proof-of-origin token for a deleted livestream wastes their evening. */
const UNAVAILABLE = /live stream recording is not available|video is unavailable|video unavailable|has been removed|no longer available|private video|members.?only|premieres in|not available in your country|blocked it in your country/i;
const NOROUTE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|SSL_ERROR|certificate/i;
const SICK = /http 5\d\d|http 4(?:0[39]|29)|Bad Gateway|Service Unavailable/i;

/** Every note in a tried-list, provider-level and instance-level alike. */
export function notesOf(tried) {
  const out = [];
  for (const t of (tried || [])) {
    if (t.note) out.push(String(t.note));
    for (const i of (t.instances || [])) if (i && i.note) out.push(String(i.note));
  }
  return out;
}

/**
 * A verdict, or null when nothing recognisable happened.
 *
 * `headline` is one sentence an operator can act on; `detail` explains the
 * reasoning so the conclusion can be argued with rather than just believed.
 */
export function verdict(tried, { hasPoToken = false, hasCookies = false } = {}) {
  const notes = notesOf(tried);
  if (!notes.length) return null;
  const any = (re) => notes.some((n) => re.test(n));

  if (any(UNAVAILABLE) && !any(BOT)) {
    const said = notes.find((n) => UNAVAILABLE.test(n)) || '';
    const quote = (said.match(UNAVAILABLE) || [''])[0];
    return {
      kind: 'unavailable',
      headline: 'YouTube says this video is not available \u2014 to anyone, not just us.',
      detail: 'Every client was answered, and the answer was ' + JSON.stringify(quote) + '. '
        + 'That is a statement about the video, not about this address or this proxy: '
        + 'deleted, private, members-only, region-locked, or an expired livestream '
        + 'recording. No token, cookie or backend changes it. Try another video to '
        + 'confirm extraction is healthy.',
    };
  }
  if (any(BOT)) {
    const missing = [
      !hasCookies && 'UMBRA_YT_COOKIES (a signed-in session)',
      !hasPoToken && 'UMBRA_YT_POTOKEN or UMBRA_POT_PROVIDER_URL (a proof-of-origin token)',
    ].filter(Boolean);
    return {
      kind: 'bot-wall',
      headline: 'This machine\u2019s IP address is bot-flagged by YouTube.',
      detail: 'YouTube served a sign-in wall to a plain browser-shaped request for the '
        + 'watch page \u2014 the most ordinary request we can make. That is a judgement about '
        + 'the address, not about how we are extracting, so no client, backend or parser '
        + 'changes this. Datacentre ranges (Codespaces, VPS, CI) are scored hardest.'
        + (missing.length
          ? ' Nothing is configured to answer it yet: set ' + missing.join(' and ') + '.'
          : ' Credentials are configured and still refused, which leaves egress: route '
            + 'through a residential address.'),
    };
  }
  if (any(GATED)) {
    return {
      kind: 'gated',
      headline: 'YouTube answered, but withheld every usable format.',
      detail: 'This is the proof-of-origin failure rather than an extraction failure: the '
        + 'request succeeded and the format list came back empty. '
        + (hasPoToken
          ? 'A token is configured, so it may be stale or bound to a different visitor identity.'
          : 'Set UMBRA_YT_POTOKEN from a browser session, or point UMBRA_POT_PROVIDER_URL at a bgutil provider.'),
    };
  }
  if (notes.every((n) => NOROUTE.test(n))) {
    return {
      kind: 'no-route',
      headline: 'Nothing on the network answered at all.',
      detail: 'Every attempt failed to connect rather than being refused by YouTube. '
        + 'This machine has no usable route out \u2014 check egress, DNS and any proxy settings.',
    };
  }
  if (any(SICK)) {
    return {
      kind: 'upstream-sick',
      headline: 'The third-party instances are unhealthy, not us.',
      detail: 'Public Piped and Invidious instances answered with server errors or refusals. '
        + 'They are frequently overloaded or blocked themselves. Umbra benches them and retries, '
        + 'but a pool of your own (UMBRA_PIPED_INSTANCES, UMBRA_INVIDIOUS_INSTANCES) is steadier.',
    };
  }
  return null;
}
