import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_SUBTYPE_ARM64_ALL = 0;
const LC_CODE_SIGNATURE = 0x1d;
const LC_SEGMENT_64 = 0x19;
const MACH_HEADER_64_BYTES = 32;
const MH_MAGIC_64 = 0xfeedfacf;
const SEGMENT_COMMAND_64_BYTES = 72;
const LINKEDIT_DATA_COMMAND_BYTES = 16;
const MACHO_PAGE_BYTES = 0x4000;
const MAX_MACHO_BYTES = 256 * 1024 * 1024;
const CODE_DIGEST_DOMAIN = Buffer.from("rbxforge:macho-arm64-code:v1\0", "ascii");
const ELECTRON_FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");

export const AUDITED_ELECTRON_FUSE_WIRE = Object.freeze({
  version: 1,
  states: Object.freeze([49, 49, 48, 49, 49, 49, 48, 49, 49]),
});

export async function createCanonicalMachOCodeEvidence(path, { expectedFuseWire } = {}) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_MACHO_BYTES) {
      throw new Error("Mach-O code evidence requires a bounded regular file.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Mach-O code evidence source changed while it was read.");
    }
    return canonicalMachOCodeEvidence(bytes, { expectedFuseWire });
  } finally {
    await handle.close();
  }
}

export function canonicalMachOCodeEvidence(value, { expectedFuseWire } = {}) {
  const bytes = Buffer.from(value);
  if (bytes.length < MACH_HEADER_64_BYTES || bytes.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error("Mach-O code evidence requires a thin little-endian 64-bit binary.");
  }
  if (bytes.readUInt32LE(4) !== CPU_TYPE_ARM64) {
    throw new Error("Mach-O code evidence requires an arm64 binary.");
  }
  if (bytes.readUInt32LE(8) !== CPU_SUBTYPE_ARM64_ALL) {
    throw new Error("Mach-O code evidence requires the audited arm64-all CPU subtype.");
  }

  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  const commandsEnd = MACH_HEADER_64_BYTES + commandBytes;
  if (commandsEnd > bytes.length) {
    throw new Error("Mach-O load-command inventory exceeds the binary.");
  }

  const canonical = Buffer.from(bytes);
  let commandOffset = MACH_HEADER_64_BYTES;
  let codeSignature;
  let linkedit;
  const fileSegments = [];
  for (let index = 0; index < commandCount; index += 1) {
    if (commandOffset + 8 > commandsEnd) {
      throw new Error("Mach-O load-command header is truncated.");
    }
    const command = bytes.readUInt32LE(commandOffset);
    const commandSize = bytes.readUInt32LE(commandOffset + 4);
    if (commandSize < 8 || commandSize % 8 !== 0 || commandOffset + commandSize > commandsEnd) {
      throw new Error("Mach-O load-command size is invalid.");
    }
    if (command === LC_SEGMENT_64) {
      if (commandSize < SEGMENT_COMMAND_64_BYTES) {
        throw new Error("Mach-O segment command is truncated.");
      }
      const segmentName = readFixedString(bytes, commandOffset + 8, 16);
      const virtualSize = readSafeUInt64(bytes, commandOffset + 32, "segment virtual size");
      const fileOffset = readSafeUInt64(bytes, commandOffset + 40, "segment file offset");
      const fileBytes = readSafeUInt64(bytes, commandOffset + 48, "segment file size");
      if (fileOffset + fileBytes > bytes.length) {
        throw new Error("Mach-O segment exceeds the binary.");
      }
      if (fileBytes > 0) {
        fileSegments.push({ name: segmentName, offset: fileOffset, end: fileOffset + fileBytes });
      }
      if (segmentName === "__LINKEDIT") {
        if (linkedit !== undefined) {
          throw new Error("Mach-O must contain exactly one __LINKEDIT segment.");
        }
        linkedit = {
          commandOffset,
          virtualSize,
          fileOffset,
          fileBytes,
          maxProtection: bytes.readInt32LE(commandOffset + 56),
          initialProtection: bytes.readInt32LE(commandOffset + 60),
        };
      }
    } else if (command === LC_CODE_SIGNATURE) {
      if (
        commandSize !== LINKEDIT_DATA_COMMAND_BYTES ||
        codeSignature !== undefined ||
        index !== commandCount - 1 ||
        commandOffset + commandSize !== commandsEnd
      ) {
        throw new Error("Mach-O must contain exactly one canonical code-signature command.");
      }
      codeSignature = {
        offset: bytes.readUInt32LE(commandOffset + 8),
        bytes: bytes.readUInt32LE(commandOffset + 12),
      };
      canonical.writeUInt32LE(0, commandOffset + 12);
    }
    commandOffset += commandSize;
  }
  if (commandOffset !== commandsEnd) {
    throw new Error("Mach-O load-command inventory length is inconsistent.");
  }
  if (linkedit === undefined || codeSignature === undefined) {
    throw new Error("Mach-O requires one __LINKEDIT segment and one code signature.");
  }
  if (
    codeSignature.offset < commandsEnd ||
    codeSignature.offset % 16 !== 0 ||
    codeSignature.bytes === 0 ||
    codeSignature.bytes % 16 !== 0 ||
    codeSignature.offset + codeSignature.bytes !== bytes.length
  ) {
    throw new Error("Mach-O code signature must occupy the exact trailing blob.");
  }
  if (
    linkedit.fileOffset % MACHO_PAGE_BYTES !== 0 ||
    linkedit.fileOffset > codeSignature.offset ||
    linkedit.fileOffset + linkedit.fileBytes !== bytes.length ||
    linkedit.virtualSize < linkedit.fileBytes ||
    linkedit.virtualSize % MACHO_PAGE_BYTES !== 0 ||
    linkedit.maxProtection !== 1 ||
    linkedit.initialProtection !== 1
  ) {
    throw new Error("Mach-O __LINKEDIT layout is invalid.");
  }
  const sortedSegments = fileSegments.sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < sortedSegments.length; index += 1) {
    if (sortedSegments[index - 1].end > sortedSegments[index].offset) {
      throw new Error("Mach-O file-backed segments overlap.");
    }
  }
  if (sortedSegments.at(-1)?.name !== "__LINKEDIT") {
    throw new Error("Mach-O __LINKEDIT must be the final file-backed segment.");
  }

  const unsignedLinkeditBytes = codeSignature.offset - linkedit.fileOffset;
  canonical.writeBigUInt64LE(BigInt(alignUp(unsignedLinkeditBytes, MACHO_PAGE_BYTES)), linkedit.commandOffset + 32);
  canonical.writeBigUInt64LE(BigInt(unsignedLinkeditBytes), linkedit.commandOffset + 48);

  if (expectedFuseWire !== undefined) {
    applyExpectedElectronFuseWire(canonical, codeSignature.offset, expectedFuseWire);
  }
  const code = canonical.subarray(0, codeSignature.offset);
  return Object.freeze({
    codeBytes: code.length,
    codeSha256: createHash("sha256").update(CODE_DIGEST_DOMAIN).update(code).digest("hex"),
  });
}

function applyExpectedElectronFuseWire(bytes, codeEnd, expectedFuseWire) {
  if (
    expectedFuseWire === null ||
    typeof expectedFuseWire !== "object" ||
    expectedFuseWire.version !== 1 ||
    !Array.isArray(expectedFuseWire.states) ||
    expectedFuseWire.states.some((state) => !new Set([48, 49, 114]).has(state))
  ) {
    throw new Error("Expected Electron fuse wire is invalid.");
  }
  const first = bytes.indexOf(ELECTRON_FUSE_SENTINEL);
  const last = bytes.lastIndexOf(ELECTRON_FUSE_SENTINEL);
  if (first < 0 || first !== last || first + ELECTRON_FUSE_SENTINEL.length + 2 > codeEnd) {
    throw new Error("Expected one Electron fuse sentinel inside signed code.");
  }
  const wireOffset = first + ELECTRON_FUSE_SENTINEL.length;
  const version = bytes[wireOffset];
  const length = bytes[wireOffset + 1];
  if (
    version !== expectedFuseWire.version ||
    length !== expectedFuseWire.states.length ||
    wireOffset + 2 + length > codeEnd
  ) {
    throw new Error("Electron fuse wire version or length changed.");
  }
  for (let index = 0; index < length; index += 1) {
    bytes[wireOffset + 2 + index] = expectedFuseWire.states[index];
  }
}

function readFixedString(bytes, offset, length) {
  const end = bytes.indexOf(0, offset);
  return bytes.toString("ascii", offset, end < 0 || end > offset + length ? offset + length : end);
}

function readSafeUInt64(bytes, offset, label) {
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Mach-O ${label} exceeds the supported range.`);
  }
  return Number(value);
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
