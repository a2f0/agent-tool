import { expect, test } from "bun:test";
import { addressGuard, isNonPublicAddress, type Lookup } from "./address";

test("non-public addresses cover loopback, private, link-local, and their IPv6 forms", () => {
  for (const address of [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fe80::1%en0", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:0:10.0.0.1", "::10.0.0.1", "64:ff9b::10.0.0.1", "64:ff9b:1::1", "2002:a00:1::1",
    "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "100::1", "2001::1", "2001:db8::1", "not-an-address",
  ]) expect({ address, nonPublic: isNonPublicAddress(address) }).toEqual({ address, nonPublic: true });
  for (const address of [
    "8.8.8.8", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.128.0.1", "169.255.0.1", "192.169.0.1", "223.255.255.255",
    "2606:4700::6810:84e5", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:0:8.8.8.8", "64:ff9b::8.8.8.8", "2002:808:808::1", "198.20.0.1", "203.0.114.1",
  ]) expect({ address, nonPublic: isNonPublicAddress(address) }).toEqual({ address, nonPublic: false });
});

const records: Record<string, string[]> = {
  "public.example": ["93.184.216.34"],
  "cdn.example": ["2606:4700::6810:84e5", "104.16.132.229"],
  "internal.example": ["10.0.0.5"],
  "mixed.example": ["93.184.216.35", "127.0.0.1"],
  localhost: ["::1", "127.0.0.1"],
};
function fakeLookup(): { lookup: Lookup; asked: string[] } {
  const asked: string[] = [];
  return { asked, lookup: async hostname => { asked.push(hostname); if (!records[hostname]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); return records[hostname]!; } };
}

test("a public named host refuses markup URLs that reach a non-public address", async () => {
  const { lookup, asked } = fakeLookup();
  const guard = await addressGuard("public.example", lookup);
  expect(guard).toBeDefined();
  const check = (url: string) => guard!(new URL(url), 5_000);
  expect(await check("https://public.example/about/")).toBeUndefined();
  expect(await check("https://cdn.example/og.png")).toBeUndefined();
  expect(await check("http://internal.example/")).toContain("refused internal.example (10.0.0.5)");
  // Any non-public address refuses the name, since fetch may connect to either.
  expect(await check("http://mixed.example/")).toContain("(127.0.0.1)");
  expect(await check("http://localhost:3000/")).toContain("refused localhost");
  // Literals need no lookup, in every form the URL parser accepts.
  for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/"]) {
    expect({ url, refused: (await check(url)) !== undefined }).toEqual({ url, refused: true });
  }
  expect(await check("http://8.8.8.8/")).toBeUndefined();
  // A name that does not resolve is left to the request; each name is looked up once.
  expect(await check("http://missing.example/")).toBeUndefined();
  await check("http://internal.example/again");
  expect(asked.sort()).toEqual(["cdn.example", "internal.example", "localhost", "missing.example", "mixed.example", "public.example"]);
});

test("a non-public named host, such as a local server, refuses nothing", async () => {
  for (const host of ["127.0.0.1:8080", "localhost:3000", "[::1]:8443", "internal.example", "10.1.2.3"]) {
    expect({ host, guard: await addressGuard(host, fakeLookup().lookup) }).toEqual({ host, guard: undefined });
  }
  // An unresolvable named host still gets the guard; the probe then reports it does not respond.
  expect(await addressGuard("missing.example", fakeLookup().lookup)).toBeDefined();
});

test("a private record beside a public one keeps the guard on, allowing only the named host", async () => {
  const guard = await addressGuard("mixed.example:8443", fakeLookup().lookup);
  expect(guard).toBeDefined();
  expect(await guard!(new URL("https://mixed.example/about/"), 5_000)).toBeUndefined();
  expect(await guard!(new URL("https://MIXED.example:9000/x"), 5_000)).toBeUndefined();
  expect(await guard!(new URL("http://internal.example/"), 5_000)).toContain("refused internal.example");
  expect(await guard!(new URL("http://127.0.0.1/"), 5_000)).toContain("refused 127.0.0.1");
});

test("a slow resolver refuses within the request's limit, and a slow named host keeps the guard", async () => {
  const hang: Lookup = hostname => hostname === "public.example" ? Promise.resolve(["93.184.216.34"]) : new Promise(() => {});
  const guard = await addressGuard("public.example", hang);
  const started = performance.now();
  expect(await guard!(new URL("http://slow.example/"), 50)).toContain("did not resolve within");
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(await addressGuard("slow.example", hang, 50)).toBeDefined();
});

test("the system resolver backs the default lookup", async () => {
  // localhost resolves from the hosts file, without the network.
  const guard = await addressGuard("93.184.216.34");
  expect(await guard!(new URL("http://localhost:8080/"), 5_000)).toContain("refused localhost");
  expect(await addressGuard("localhost:3000")).toBeUndefined();
}, 30_000);
