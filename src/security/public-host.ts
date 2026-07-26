import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type PublicHostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemPublicHostResolver: PublicHostResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
};

export async function assertPublicHttpUrl(value: string, resolver: PublicHostResolver = systemPublicHostResolver): Promise<void> {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs are allowed");
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily as 4 | 6 }] : await resolver(hostname);
  if (addresses.length === 0 || addresses.some(({ address, family }) => isReservedAddress(address, family))) {
    throw new Error("The URL resolves to a private or reserved network address");
  }
}

export function isReservedAddress(address: string, family = isIP(address) as 4 | 6): boolean {
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b, c] = octets as [number, number, number, number];
    return a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 2 || b === 168) || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 && c === 113 || a >= 224;
  }
  if (family !== 6 || !/^[0-9a-f:.]+$/iu.test(address)) return true;
  const normalized = address.toLowerCase();
  const mapped = ipv4MappedAddress(normalized);
  if (mapped) return isReservedAddress(mapped, 4);
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("2001:db8") || normalized.startsWith("2001:10") || normalized.startsWith("2001:20") || normalized.startsWith("2001:2");
}

function ipv4MappedAddress(address: string): string | undefined {
  const dotted = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(address)?.[1];
  if (dotted) return dotted;
  const groups = expandIpv6(address);
  if (!groups || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) return undefined;
  const high = groups[6]!;
  const low = groups[7]!;
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function expandIpv6(address: string): number[] | undefined {
  if (address.includes(".")) return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const raw = halves.length === 2 ? [...left, ...Array.from({ length: missing }, () => "0"), ...right] : left;
  if (raw.length !== 8 || raw.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
  return raw.map((group) => Number.parseInt(group, 16));
}
