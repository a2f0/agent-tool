/**
 * Which hosts `seo probe` may request when a URL comes from fetched markup or a
 * redirect rather than the command line: a hostile page could otherwise point
 * the probe at this machine or its network (`og:image` on `169.254.169.254`, a
 * sitemap entry on `localhost`) and print what answers.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Every address a hostname resolves to; an unresolvable name has none. */
export type Lookup = (hostname: string) => Promise<string[]>;
/** Why a URL must not be requested, or undefined when it may be, deciding within `milliseconds`. */
export type Guard = (url: URL, milliseconds: number) => Promise<string | undefined>;

const systemLookup: Lookup = async hostname => (await dnsLookup(hostname, { all: true, verbatim: true })).map(entry => entry.address);

/**
 * IPv4 ranges outside the public internet: this network, private, shared
 * (CGNAT), loopback, link-local, IETF protocol assignments, documentation,
 * benchmarking, and multicast or reserved.
 */
const V4_RANGES: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
];

function ipv4(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

const inRange = (value: number, [base, bits]: [string, number]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(ipv4(base) / 2 ** (32 - bits));
const nonPublicV4 = (address: string) => V4_RANGES.some(range => inRange(ipv4(address), range));

/** The eight 16-bit groups of an IPv6 address, with a trailing dotted IPv4 part expanded. */
function ipv6Groups(address: string): number[] {
  let text = address.replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const value = ipv4(dotted[1]!);
    text = `${text.slice(0, dotted.index)}${Math.floor(value / 65536).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => part ? part.split(":").map(group => parseInt(group, 16)) : [];
  const left = parse(head), right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

const embeddedV4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/** Loopback, link-local, private, unspecified, multicast, or reserved: anything that is not a public unicast address. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address.replace(/%.*$/, ""));
  if (family === 4) return nonPublicV4(address);
  if (family !== 6) return true;
  const groups = ipv6Groups(address);
  const [a = 0, b = 0, , , , f = 0, g = 0, h = 0] = groups;
  const zeros = (count: number) => groups.slice(0, count).every(group => group === 0);
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d are that IPv4 address; the rest of ::/96 is unspecified, loopback, or deprecated.
  if ((zeros(5) && f === 0xffff) || (zeros(4) && groups[4] === 0xffff && f === 0)) return nonPublicV4(embeddedV4(g, h));
  if (zeros(6)) return true;
  // NAT64 well-known prefix 64:ff9b::/96, and 6to4 2002::/16, which carry an IPv4 address.
  if (a === 0x64 && b === 0xff9b && groups.slice(2, 6).every(group => group === 0)) return nonPublicV4(embeddedV4(g, h));
  if (a === 0x2002) return nonPublicV4(embeddedV4(b, groups[2] ?? 0));
  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, local-use NAT64 64:ff9b:1::/48,
  // discard 100::/64, Teredo 2001::/32, and documentation 2001:db8::/32.
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0 || (a & 0xff00) === 0xff00 || (a === 0x64 && b === 0xff9b && groups[2] === 1)
    || (a === 0x100 && groups.slice(1, 4).every(group => group === 0)) || (a === 0x2001 && (b === 0 || b === 0xdb8));
}

/** The promise's value, or undefined when it takes longer than `milliseconds`. */
async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(resolve, Math.max(0, milliseconds), undefined); })]);
  } finally { clearTimeout(timer); }
}

/** How long the named host's own lookup may take before the guard assumes it is public. */
const NAMED_LOOKUP_MILLISECONDS = 15_000;

/**
 * The guard for URLs that markup or redirects supply, or undefined when every
 * address of the named host is non-public (probing a local server), since then
 * every target is the user's own network. Otherwise a host that is, or resolves
 * to, any non-public address is refused, except the named host itself, which
 * the user chose: a page cannot switch the guard off, or reach this network
 * through another name, by publishing a private record beside a public one.
 * Names resolve once per run through the system resolver, as `fetch` resolves
 * them. A name that does not resolve is left to the request, which fails or
 * goes through a proxy; one that does not resolve within the request's time
 * limit is refused. The check runs just before each request, so a name that
 * resolves differently by the time `fetch` connects (DNS rebinding) is not
 * caught.
 */
export async function addressGuard(namedHost: string, lookup: Lookup = systemLookup, namedMilliseconds = NAMED_LOOKUP_MILLISECONDS): Promise<Guard | undefined> {
  const cache = new Map<string, Promise<string[]>>();
  const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "");
  const addresses = (hostname: string) => {
    let found = cache.get(hostname);
    if (!found) {
      found = isIP(hostname) ? Promise.resolve([hostname]) : lookup(hostname).catch(() => []);
      cache.set(hostname, found);
    }
    return found;
  };
  const named = bare(new URL(`http://${namedHost}/`).hostname);
  const own = await within(addresses(named), namedMilliseconds);
  if (own?.length && own.every(isNonPublicAddress)) return undefined;
  return async (url, milliseconds) => {
    const hostname = bare(url.hostname);
    if (hostname === named) return undefined;
    const found = await within(addresses(hostname), milliseconds);
    if (found === undefined) return `refused ${hostname}: it did not resolve within the request's time limit`;
    const address = found.find(isNonPublicAddress);
    return address === undefined ? undefined : `refused ${hostname} (${address}): a non-public address that the command line did not name`;
  };
}
