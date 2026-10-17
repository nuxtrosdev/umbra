/* Turning a bind address into addresses a human can actually open.
 *
 * `0.0.0.0` is an instruction to the kernel — "accept on every interface" —
 * not a destination. Browsers are within their rights to refuse it, and
 * Chrome on Windows does exactly that with ERR_ADDRESS_INVALID. Printing the
 * bind address in the startup banner therefore hands the one person who
 * needs a working URL the one URL guaranteed not to work.
 *
 * This maps a bind address to the set of URLs that reach it: always
 * localhost, plus each non-internal IPv4/IPv6 address of the machine when the
 * bind was a wildcard, so a phone on the same network can be pointed at it
 * too. A specific bind address is simply echoed back — it is already the
 * answer.
 */

import os from 'node:os';

const WILDCARD = new Set(['0.0.0.0', '::', '::0', '0000:0000:0000:0000:0000:0000:0000:0000', '', '*']);

export function isWildcard(host) {
  return WILDCARD.has(String(host == null ? '' : host).trim().toLowerCase());
}

/** Wrap bare IPv6 literals in brackets so they survive being put in a URL. */
export function hostForUrl(addr, family) {
  const a = String(addr);
  const v6 = family === 6 || family === 'IPv6' || (a.includes(':') && !a.startsWith('['));
  return v6 ? `[${a.replace(/%.*$/, '')}]` : a;
}

/**
 * @returns {{ primary: string, lan: string[], all: string[] }}
 *   `primary` is what to open on this machine, `lan` the addresses other
 *   devices on the network can use, `all` both in display order.
 */
export function listenUrls(host, port, { scheme = 'http' } = {}) {
  const p = Number(port);
  const url = (h) => `${scheme}://${h}:${p}`;

  if (!isWildcard(host)) {
    const one = url(hostForUrl(host));
    return { primary: one, lan: [], all: [one] };
  }

  const primary = url('localhost');
  const lan = [];
  let ifaces = {};
  try {
    ifaces = os.networkInterfaces() || {};
  } catch {
    /* An unreadable interface list is not worth failing a startup over. */
  }

  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (!ni || ni.internal) continue;
      /* Link-local v6 needs a scope id to be usable; skip rather than lie. */
      if (/^fe80:/i.test(ni.address)) continue;
      const u = url(hostForUrl(ni.address, ni.family));
      if (!lan.includes(u)) lan.push(u);
    }
  }

  /* IPv4 first: it is the one most people can type back to us. */
  lan.sort((a, b) => Number(a.includes('[')) - Number(b.includes('[')));
  return { primary, lan, all: [primary, ...lan] };
}

/** The startup banner lines, as an array so callers choose how to print. */
export function listenBanner(host, port, opts = {}) {
  const { primary, lan } = listenUrls(host, port, opts);
  const lines = [`open this:  ${primary}`];
  if (lan.length) {
    lines.push(`on your network:  ${lan.slice(0, 3).join('  ')}`);
  }
  if (isWildcard(host)) {
    lines.push(`(bound to ${host}:${port} — that is every interface, not an address you can open)`);
  }
  return lines;
}

export default listenUrls;
