import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

export function isLoopbackPeer(address: string | null | undefined): boolean {
  if (address == null) {
    return false;
  }
  const normalized = normalizeHost(address);
  if (normalized.startsWith("::ffff:")) {
    return isIpv4Loopback(normalized.slice("::ffff:".length));
  }
  return normalized === "::1" || isIpv4Loopback(normalized);
}

export function isTrustedPeer(address: string | null | undefined, trustedPeers: string[]): boolean {
  if (address == null) {
    return false;
  }
  const normalized = normalizeHost(address);
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  for (const peer of trustedPeers) {
    if (peer.includes("/")) {
      if (ipv4CidrContains(peer, ipv4)) {
        return true;
      }
    } else if (normalizeHost(peer) === normalized || normalizeHost(peer) === ipv4) {
      return true;
    }
  }
  return false;
}

function assertValidPeers(peers: string[]): string[] {
  for (const peer of peers) {
    if (!isValidPeer(peer)) {
      throw new Error(
        `invalid trusted peer ${JSON.stringify(peer)}: expected an IP address ` +
          "or an IPv4 CIDR such as 203.0.113.0/24",
      );
    }
  }
  return peers;
}

function isValidPeer(peer: string): boolean {
  if (!peer.includes("/")) {
    return isIP(normalizeHost(peer)) !== 0;
  }
  const [address, bits, ...extra] = peer.split("/");
  return (
    extra.length === 0 &&
    ipv4ToInt(address ?? "") != null &&
    /^\d{1,2}$/.test(bits ?? "") &&
    Number(bits) <= 32
  );
}

export function parsePeerList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((peer) => peer.trim())
    .filter((peer) => peer !== "");
}

const DEFAULT_ROUTE_TABLE_PATH = "/proc/net/route";

const DEFAULT_SYS_CLASS_NET_PATH = "/sys/class/net";

/** `/proc/net/route` flag bits: the route is usable, and it hops through a
 * gateway instead of being on-link. */
const RTF_UP = 0x1;

const RTF_GATEWAY = 0x2;

/** Bound on gateway auto-trust, not an allowlist. Only the detected bridge
 * gateway is trusted; host, macvlan, ipvlan, LAN, and VPC gateways are excluded. */
const GATEWAY_AUTO_TRUST_RANGE = "172.16.0.0/12";

/** Test seam: where the Linux network facts are read from. */
export interface TrustedPeerSources {
  routeTablePath?: string;
  sysClassNetPath?: string;
}

/** Peers admitted on a non-loopback bind, resolved once at startup. The first
 * present source replaces the rest (an empty DECANT_TRUSTED_PEERS trusts
 * nobody); precedence is documented in docs/api/routes.md. */
export function resolveTrustedPeers(
  configured?: string[],
  env: Record<string, string | undefined> = process.env,
  sources: TrustedPeerSources = {},
): string[] {
  if (configured != null) {
    return assertValidPeers(configured);
  }
  if (env.DECANT_TRUSTED_PEERS != null) {
    return assertValidPeers(parsePeerList(env.DECANT_TRUSTED_PEERS));
  }
  if (!isEnvEnabled(env.DECANT_TRUST_DEFAULT_GATEWAY)) {
    return [];
  }
  const gateway = containerBridgeGateway(
    sources.routeTablePath ?? DEFAULT_ROUTE_TABLE_PATH,
    sources.sysClassNetPath ?? DEFAULT_SYS_CLASS_NET_PATH,
  );
  return gateway == null ? [] : [gateway];
}

/** This container's own bridge gateway, or `null` when that cannot be proven.
 *
 * Runtimes rewrite the source of `-p`-published host traffic to this address,
 * so it stands in for the host while sibling containers stay denied. That only
 * holds for a veth into another network namespace: on host networking, macvlan
 * or ipvlan the default gateway is a LAN or VPC router that must never be
 * trusted implicitly, so every unproven shape (and any non-Linux host) fails
 * closed. See docs/distribution.md#docker. */
function containerBridgeGateway(routeTablePath: string, sysClassNetPath: string): string | null {
  const routes = readRouteTable(routeTablePath);
  if (routes == null) {
    return null;
  }
  const defaults = routes.filter(
    (route) =>
      route.destination === 0 &&
      route.gateway !== 0 &&
      (route.flags & RTF_UP) !== 0 &&
      (route.flags & RTF_GATEWAY) !== 0,
  );
  const route = defaults.length === 1 ? defaults[0] : undefined;
  if (route == null) {
    return null;
  }
  const gateway = formatIpv4(route.gateway);
  if (!ipv4CidrContains(GATEWAY_AUTO_TRUST_RANGE, gateway)) {
    return null;
  }
  if (!hasOnLinkRoute(routes, route.iface, route.gateway)) {
    return null;
  }
  return isContainerVeth(route.iface, sysClassNetPath) ? gateway : null;
}

interface RouteRow {
  iface: string;
  destination: number;
  gateway: number;
  flags: number;
  mask: number;
}

/** Rows of the Linux IPv4 route table, or `null` when it cannot be read (any
 * non-Linux host), which leaves the guard closed rather than guessing. */
function readRouteTable(routeTablePath: string): RouteRow[] | null {
  let table: string;
  try {
    table = readFileSync(routeTablePath, "utf8");
  } catch {
    return null;
  }
  const rows: RouteRow[] = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const iface = fields[0] ?? "";
    const destination = routeHexToIpv4(fields[1]);
    const gateway = routeHexToIpv4(fields[2]);
    const flags = Number.parseInt(fields[3] ?? "", 16);
    const mask = routeHexToIpv4(fields[7]);
    if (
      iface === "" ||
      destination == null ||
      gateway == null ||
      mask == null ||
      !Number.isFinite(flags)
    ) {
      continue;
    }
    rows.push({ iface, destination, gateway, flags, mask });
  }
  return rows;
}

/** A gateway reachable without another hop on the same interface, which is how
 * a container's bridge gateway always appears. */
function hasOnLinkRoute(routes: RouteRow[], iface: string, gateway: number): boolean {
  return routes.some(
    (route) =>
      route.iface === iface &&
      route.mask !== 0 &&
      (route.flags & RTF_UP) !== 0 &&
      (route.flags & RTF_GATEWAY) === 0 &&
      (route.destination & route.mask) >>> 0 === (gateway & route.mask) >>> 0,
  );
}

/** Whether `iface` is this container's veth: a virtual device, not stacked on a
 * parent in this namespace, whose link peer lives in another namespace. The
 * host's own namespace never satisfies all three for its default route. */
function isContainerVeth(iface: string, sysClassNetPath: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(iface)) {
    return false;
  }
  const dir = join(sysClassNetPath, iface);
  // vlan, macvlan, ipvlan, bridge and bond devices all publish their kind here,
  // so a container sitting directly on the LAN is refused. Kernels that publish
  // no DEVTYPE for veth leave the structural checks below to decide.
  const devType = readDevType(join(dir, "uevent"));
  if (devType != null && devType !== "veth") {
    return false;
  }
  // A physical NIC -- so, the host's namespace -- has a backing bus device.
  if (existsSync(join(dir, "device"))) {
    return false;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  // Devices stacked on a parent in this namespace publish lower_* links.
  if (entries.some((entry) => entry.startsWith("lower_"))) {
    return false;
  }
  const ifIndex = readIfIndex(join(dir, "ifindex"));
  const ifLink = readIfIndex(join(dir, "iflink"));
  // A container veth names a peer that lives in another namespace, so the index
  // it links to must not resolve here. A bridge, bond or tunnel links to itself
  // (the degenerate case of the same rule), and a veth pair with both ends in
  // this namespace is not a container boundary.
  if (ifIndex == null || ifLink == null || ifIndex === ifLink) {
    return false;
  }
  const localIndexes = collectIfIndexes(sysClassNetPath);
  return localIndexes != null && !localIndexes.has(ifLink);
}

function readDevType(ueventPath: string): string | null {
  let uevent: string;
  try {
    uevent = readFileSync(ueventPath, "utf8");
  } catch {
    return null;
  }
  for (const line of uevent.split("\n")) {
    const [key, value] = line.split("=", 2);
    if (key?.trim() === "DEVTYPE") {
      return value?.trim().toLowerCase() ?? null;
    }
  }
  return null;
}

function readIfIndex(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Every interface index visible in this network namespace, or `null` when the
 * directory cannot be listed. */
function collectIfIndexes(sysClassNetPath: string): Set<number> | null {
  let entries: string[];
  try {
    entries = readdirSync(sysClassNetPath);
  } catch {
    return null;
  }
  const indexes = new Set<number>();
  for (const entry of entries) {
    const value = readIfIndex(join(sysClassNetPath, entry, "ifindex"));
    if (value != null) {
      indexes.add(value);
    }
  }
  return indexes;
}

/** `/proc/net/route` prints each address as the little-endian reading of its
 * network-byte-order word, so the low byte is the first octet. The image ships
 * for amd64 and arm64 only; on a big-endian host this misreads into an address
 * outside `GATEWAY_AUTO_TRUST_RANGE`, which fails closed. */
function routeHexToIpv4(value: string | undefined): number | null {
  if (value == null || !/^[0-9a-fA-F]{8}$/.test(value)) {
    return null;
  }
  const raw = Number.parseInt(value, 16) >>> 0;
  return (
    (((raw & 0xff) << 24) |
      (((raw >>> 8) & 0xff) << 16) |
      (((raw >>> 16) & 0xff) << 8) |
      ((raw >>> 24) & 0xff)) >>>
    0
  );
}

function formatIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    ".",
  );
}

function isEnvEnabled(value: string | undefined): boolean {
  return value?.trim() === "1";
}

function ipv4CidrContains(cidr: string, address: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number.parseInt(bitsRaw ?? "", 10);
  const baseInt = ipv4ToInt(base ?? "");
  const addressInt = ipv4ToInt(address);
  if (baseInt == null || addressInt == null || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (baseInt & mask) === (addressInt & mask);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    !octets.every((octet, index) => String(octet) === parts[index] && octet >= 0 && octet <= 255)
  ) {
    return null;
  }
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

export function normalizeHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

export function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  return (
    octets.every((octet, index) => String(octet) === parts[index] && octet >= 0 && octet <= 255) &&
    octets[0] === 127
  );
}
