import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

const maximumUint16 = 0xffff;
const maximumUint32 = 0xffffffff;
const utf8Flag = 0x0800;
const dosDate = (1 << 5) | 1;

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data) {
  let value = maximumUint32;
  for (const byte of data)
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ maximumUint32) >>> 0;
}

function checkedName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe ZIP entry path: ${String(name)}`);
  }
  const encoded = Buffer.from(name, "utf8");
  if (encoded.length > maximumUint16)
    throw new Error(`ZIP entry name is too long: ${name}`);
  return encoded;
}

function assertClassicZipLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximumUint32) {
    throw new Error(`${label} exceeds the classic ZIP limit`);
  }
}

function localHeader(name, data, checksum) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(utf8Flag, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function centralHeader(name, data, checksum, offset, mode) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(utf8Flag, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

export function createDeterministicZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("A ZIP archive requires at least one file");
  }
  if (entries.length > maximumUint16)
    throw new Error("ZIP has too many entries");

  const normalized = entries
    .map((entry) => {
      const name = checkedName(entry.name);
      const data = Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data);
      assertClassicZipLimit(data.length, `ZIP entry ${entry.name}`);
      return { data, mode: entry.mode ?? 0o100644, name, path: entry.name };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  if (
    new Set(normalized.map((entry) => entry.path)).size !== normalized.length
  ) {
    throw new Error("ZIP entry paths must be unique");
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of normalized) {
    const checksum = crc32(entry.data);
    const local = localHeader(entry.name, entry.data, checksum);
    localParts.push(local, entry.name, entry.data);
    centralParts.push(
      centralHeader(entry.name, entry.data, checksum, offset, entry.mode),
      entry.name,
    );
    offset += local.length + entry.name.length + entry.data.length;
    assertClassicZipLimit(offset, "ZIP local data");
  }

  const centralSize = centralParts.reduce(
    (total, part) => total + part.length,
    0,
  );
  assertClassicZipLimit(centralSize, "ZIP central directory");
  assertClassicZipLimit(offset + centralSize, "ZIP archive");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export async function writeDeterministicZip(path, entries) {
  await writeFile(path, createDeterministicZip(entries));
}
