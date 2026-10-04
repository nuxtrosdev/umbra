/**
 * Instance pools and the health bookkeeping behind them.
 *
 * A provider like Invidious or Piped is not one server, it is a rotating cast
 * of volunteer-run ones with wildly different uptime. The pool is what turns
 * that into something dependable: every instance carries its own health
 * record, failures are remembered, dead instances are benched instead of
 * retried, and selection prefers whatever has actually been working.
 *
 * Scoring deliberately does not randomise. Random choice spreads load but
 * also spreads failure — it will keep posting one request in four at an
 * instance that has timed out all morning. Instead healthy-and-fast is
 * preferred, with enough weight on recency that a recovered instance climbs
 * back without needing a restart.
 */

import { upstream, readBody } from '../net.mjs';

const nowMs = () => Date.now();

/** Failures needed before an instance is benched rather than just demoted. */
const FAIL_LIMIT = Number(process.env.UMBRA_PROVIDER_FAIL_LIMIT || 3);
/** How long a benched instance is left alone. Doubles per consecutive bench. */
const COOLDOWN = Number(process.env.UMBRA_PROVIDER_COOLDOWN || 120000);
const COOLDOWN_MAX = Number(process.env.UMBRA_PROVIDER_COOLDOWN_MAX || 1800000);
const TIMEOUT = Number(process.env.UMBRA_PROVIDER_TIMEOUT || 8000);
/** Attempts per capability call, across instances. Not unlimited, by design. */
const MAX_ATTEMPTS = Number(process.env.UMBRA_PROVIDER_MAX_ATTEMPTS || 3);

export const POOL_DEFAULTS = { FAIL_LIMIT, COOLDOWN, COOLDOWN_MAX, TIMEOUT, MAX_ATTEMPTS };

let LOG = [];
const LOG_MAX = 300;

/** Structured, bounded, and readable from the debug endpoint. */
export function log(event) {
  LOG.push({ at: new Date().toISOString(), ...event });
  if (LOG.length > LOG_MAX) LOG = LOG.slice(-LOG_MAX);
}
export function recentLog(n = 60) { return LOG.slice(-n); }
export function clearLog() { LOG = []; }

/* ------------------------------------------------------------ instance */

export class ProviderInstance {
  constructor(baseUrl, provider, { capabilities = [], id = null, local = false } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.provider = provider;
    this.id = id || `${provider}:${this.baseUrl.replace(/^https?:\/\//, '') || 'local'}`;
    this.capabilities = capabilities;
    this.local = local;

    this.healthy = true;
    this.latency = null;
    this.failures = 0;          /* consecutive */
    this.benches = 0;           /* consecutive cooldowns, for backoff */
    this.totalOk = 0;
    this.totalFail = 0;
    this.lastChecked = null;
    this.lastSuccess = null;
    this.lastFailure = null;
    this.lastError = null;
    this.cooldownUntil = null;
  }

  get available() {
    if (!this.cooldownUntil) return true;
    if (nowMs() >= this.cooldownUntil) {
      /* probation: one attempt is allowed through to find out if it is back */
      this.cooldownUntil = null;
      this.healthy = true;
      return true;
    }
    return false;
  }

  /** Share of requests that succeeded. Unknown counts as optimistic. */
  get successRate() {
    const n = this.totalOk + this.totalFail;
    return n ? this.totalOk / n : 1;
  }

  succeed(ms) {
    this.healthy = true;
    this.latency = ms;
    this.failures = 0;
    this.benches = 0;
    this.totalOk++;
    this.lastChecked = this.lastSuccess = new Date().toISOString();
    this.cooldownUntil = null;
    this.lastError = null;
  }

  fail(err) {
    this.failures++;
    this.totalFail++;
    this.lastChecked = this.lastFailure = new Date().toISOString();
    this.lastError = String((err && err.message) || err).slice(0, 200);
    if (this.failures >= FAIL_LIMIT) {
      /* exponential backoff, capped — a long-dead instance should cost us
         one request every half hour, not one every two minutes */
      const wait = Math.min(COOLDOWN * Math.pow(2, this.benches), COOLDOWN_MAX);
      this.cooldownUntil = nowMs() + wait;
      this.benches++;
      this.failures = 0;
      this.healthy = false;
    }
  }

  /**
   * Higher is better. Reliability dominates, latency breaks ties, and a
   * benched instance is pushed below everything that still answers.
   */
  score() {
    if (!this.available) return -1;
    const reliability = this.successRate * 100;
    const speed = this.latency === null ? 25 : Math.max(0, 40 - this.latency / 50);
    const recency = this.lastSuccess ? 10 : 0;
    const warming = this.failures * -15;
    const localBonus = this.local ? 20 : 0;
    return reliability + speed + recency + warming + localBonus;
  }

  status() {
    if (!this.available) return 'COOLDOWN';
    if (!this.lastChecked) return 'UNKNOWN';
    /* Failing but not yet benched is its own state. Reporting it as ONLINE
       because the bench threshold has not been crossed hides exactly the
       instance an operator is looking for when something feels slow. */
    if (this.failures > 0) return 'DEGRADED';
    if (!this.healthy) return 'DEGRADED';
    return this.lastSuccess ? 'ONLINE' : 'UNKNOWN';
  }

  report() {
    return {
      id: this.id,
      provider: this.provider,
      baseUrl: this.baseUrl || '(in-process)',
      status: this.status(),
      healthy: this.healthy,
      latency: this.latency,
      failures: this.failures,
      successRate: Number(this.successRate.toFixed(3)),
      requests: this.totalOk + this.totalFail,
      capabilities: this.capabilities,
      lastChecked: this.lastChecked,
      lastSuccess: this.lastSuccess,
      lastFailure: this.lastFailure,
      lastError: this.lastError,
      cooldownUntil: this.cooldownUntil ? new Date(this.cooldownUntil).toISOString() : null,
      score: Number(this.score().toFixed(1)),
    };
  }
}

/* ---------------------------------------------------------------- pool */

export class InstancePool {
  constructor(provider, baseUrls = [], opts = {}) {
    this.provider = provider;
    this.instances = baseUrls.map((b) =>
      (b instanceof ProviderInstance ? b : new ProviderInstance(b, provider, opts)));
  }

  add(inst) { this.instances.push(inst); return this; }

  /** Best first. Benched instances are included last so a pool that is
      entirely benched can still be tried rather than failing outright. */
  order() {
    return [...this.instances].sort((a, b) => b.score() - a.score());
  }

  report() { return this.instances.map((i) => i.report()); }

  /**
   * Run `fn(instance)` against instances in score order until one succeeds.
   *
   * Bounded by MAX_ATTEMPTS: without a cap, a 30-instance pool having a bad
   * day turns one user request into thirty upstream requests and a timeout
   * measured in minutes.
   */
  async run(fn, { attempts = MAX_ATTEMPTS, capability = null } = {}) {
    const tried = [];
    const candidates = this.order()
      .filter((i) => !capability || !i.capabilities.length || i.capabilities.includes(capability));
    let n = 0;
    for (const inst of candidates) {
      if (n >= attempts) break;
      if (!inst.available) continue;
      n++;
      const t0 = nowMs();
      try {
        const out = await fn(inst);
        inst.succeed(nowMs() - t0);
        log({ provider: this.provider, instance: inst.id, capability, ok: true, ms: nowMs() - t0 });
        return { data: out, instance: inst, tried };
      } catch (e) {
        inst.fail(e);
        const note = String((e && e.message) || e).slice(0, 160);
        tried.push({ instance: inst.id, note });
        log({ provider: this.provider, instance: inst.id, capability, ok: false, ms: nowMs() - t0, error: note });
      }
    }
    const err = new Error(
      n === 0
        ? `every ${this.provider} instance is in cooldown`
        : `no ${this.provider} instance answered`);
    err.tried = tried;
    throw err;
  }
}

/* ------------------------------------------------------------- fetching */

/**
 * JSON over the existing raw-http layer rather than fetch, matching how the
 * rest of this proxy talks upstream.
 */
export async function getJson(urlStr, { timeout = TIMEOUT, headers = {}, limit = 8 * 1024 * 1024 } = {}) {
  const res = await upstream(urlStr, {
    timeout,
    headers: {
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      ...headers,
    },
  });
  if (res.status !== 200) {
    res.res.resume();
    throw new Error('http ' + res.status);
  }
  const body = (await readBody(res.res, { limit })).toString('utf8');
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('response was not json'); }
  /* Several of these projects report upstream extraction failures as a 200
     with an error field. That is a failure, not data. */
  if (json && !Array.isArray(json) && typeof json === 'object' && json.error) {
    throw new Error(String(json.error).slice(0, 160));
  }
  return json;
}

/** Comma/whitespace separated env list, empty-safe. */
export function envList(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(/[,\s]+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
