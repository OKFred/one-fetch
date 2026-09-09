export type IpKind = "ipv4" | "ipv6";

interface ParsedIp {
  kind: IpKind;
  bits: 32 | 128;
  value: bigint;
}

function parseIpv4(value: string): ParsedIp | undefined {
  const pieces = value.split(".");
  if (pieces.length !== 4) return undefined;
  let result = 0n;
  for (const piece of pieces) {
    if (!/^(0|[1-9][0-9]{0,2})$/u.test(piece)) return undefined;
    const octet = Number(piece);
    if (octet > 255) return undefined;
    result = (result << 8n) | BigInt(octet);
  }
  return { kind: "ipv4", bits: 32, value: result };
}

function ipv4Tail(value: string): string[] | undefined {
  const parsed = parseIpv4(value);
  if (parsed === undefined) return undefined;
  return [
    Number((parsed.value >> 16n) & 0xffffn).toString(16),
    Number(parsed.value & 0xffffn).toString(16),
  ];
}

function parseIpv6(value: string): ParsedIp | undefined {
  let normalized = value.toLowerCase();
  const zone = normalized.indexOf("%");
  if (zone >= 0) normalized = normalized.slice(0, zone);
  const lastColon = normalized.lastIndexOf(":");
  if (normalized.includes(".") && lastColon >= 0) {
    const tail = ipv4Tail(normalized.slice(lastColon + 1));
    if (tail === undefined) return undefined;
    normalized = `${normalized.slice(0, lastColon)}:${tail.join(":")}`;
  }
  if (!/^[0-9a-f:]+$/u.test(normalized) || normalized.includes(":::"))
    return undefined;
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right =
    halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  if (
    left.some((piece) => !/^[0-9a-f]{1,4}$/u.test(piece)) ||
    right.some((piece) => !/^[0-9a-f]{1,4}$/u.test(piece))
  ) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return undefined;
  const pieces = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (pieces.length !== 8) return undefined;
  let result = 0n;
  for (const piece of pieces) result = (result << 16n) | BigInt(`0x${piece}`);
  return { kind: "ipv6", bits: 128, value: result };
}

export function parseIp(value: string): ParsedIp | undefined {
  return parseIpv4(value) ?? parseIpv6(value.replace(/^\[|\]$/gu, ""));
}

export function isIpLiteral(value: string): boolean {
  return parseIp(value) !== undefined;
}

export function ipInCidr(address: string, cidr: string): boolean {
  const separator = cidr.lastIndexOf("/");
  if (separator < 0) return false;
  const network = parseIp(cidr.slice(0, separator));
  const candidate = parseIp(address);
  const prefix = Number(cidr.slice(separator + 1));
  if (
    network === undefined ||
    candidate === undefined ||
    network.kind !== candidate.kind ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > network.bits
  ) {
    return false;
  }
  if (prefix === 0) return true;
  const shift = BigInt(network.bits - prefix);
  return network.value >> shift === candidate.value >> shift;
}
