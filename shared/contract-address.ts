/**
 * CA（合约地址）提取与严格校验。
 *
 * 依据：Q119（严格校验，失败不显示，但保留原文片段）、Q123（链标识 + 地址双字段，未知链只保留片段）。
 * 约束：不引入新依赖（Q128），因此在此实现 Keccak-256 用于 EVM 的 EIP-55 校验和校验。
 */

import type { ContractAddressExtraction, ContractAddressRecord, ContractAddressRejection } from './domain.js';

const MASK64 = (1n << 64n) - 1n;

/** Keccak-f[1600] 轮常量。 */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** rho 旋转偏移，按 (x + 5y) 索引。 */
const ROTATION_OFFSETS: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl64(value: bigint, shift: number): bigint {
  const amount = BigInt(shift % 64);
  if (amount === 0n) return value & MASK64;
  return ((value << amount) | (value >> (64n - amount))) & MASK64;
}

/** Keccak-f[1600] 置换（24 轮）。 */
function keccakF1600(lanes: bigint[]): void {
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);
  const b = new Array<bigint>(25);

  for (const roundConstant of ROUND_CONSTANTS) {
    // theta
    for (let x = 0; x < 5; x += 1) {
      c[x] = lanes[x]! ^ lanes[x + 5]! ^ lanes[x + 10]! ^ lanes[x + 15]! ^ lanes[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        lanes[index] = (lanes[index]! ^ d[x]!) & MASK64;
      }
    }

    // rho + pi
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const target = y + 5 * ((2 * x + 3 * y) % 5);
        b[target] = rotl64(lanes[x + 5 * y]!, ROTATION_OFFSETS[x + 5 * y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        lanes[index] = (b[index]! ^ (~b[(x + 1) % 5 + 5 * y]! & b[(x + 2) % 5 + 5 * y]!)) & MASK64;
      }
    }

    // iota
    lanes[0] = (lanes[0]! ^ roundConstant) & MASK64;
  }
}

/** Keccak-256（注意不是 SHA3-256：填充域为 0x01）。 */
export function keccak256(input: Uint8Array): Uint8Array {
  const rateBytes = 136;
  const lanes = new Array<bigint>(25).fill(0n);

  const padded = new Uint8Array(Math.ceil((input.length + 1) / rateBytes) * rateBytes);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1]! | 0x80) & 0xff;

  for (let offset = 0; offset < padded.length; offset += rateBytes) {
    for (let lane = 0; lane < rateBytes / 8; lane += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      }
      lanes[lane] = (lanes[lane]! ^ value) & MASK64;
    }
    keccakF1600(lanes);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane += 1) {
    let value = lanes[lane]!;
    for (let byte = 0; byte < 8; byte += 1) {
      out[lane * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

const HEX_CHARS = '0123456789abcdef';

/** EIP-55 校验和地址。 */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = keccak256(new TextEncoder().encode(lower));
  let result = '0x';
  for (let i = 0; i < lower.length; i += 1) {
    const character = lower[i]!;
    if (!/[0-9a-f]/.test(character)) {
      result += character;
      continue;
    }
    const nibble = i % 2 === 0 ? hash[i / 2]! >> 4 : hash[(i - 1) / 2]! & 0x0f;
    result += nibble >= 8 ? character.toUpperCase() : character;
  }
  return result;
}

export function isValidChecksumAddress(address: string): boolean {
  const body = address.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{40}$/.test(body)) return false;
  // 全小写或全大写视为未提供校验和，仍然合法。
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(body) === `0x${body}`;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null;
  let num = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) return null;
    num = num * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export const SOLANA_CHAIN_ID = 'sol';
export const EVM_CHAIN_IDS = ['eth', 'bsc', 'base', 'arb', 'polygon'] as const;

/** 链别名，用于从报告文字或用户输入推断链标识。 */
const CHAIN_ALIASES: Readonly<Record<string, string>> = {
  sol: 'sol',
  solana: 'sol',
  spl: 'sol',
  eth: 'eth',
  ethereum: 'eth',
  erc20: 'eth',
  erc: 'eth',
  bsc: 'bsc',
  bnb: 'bsc',
  bep20: 'bsc',
  base: 'base',
  arbitrum: 'arb',
  arb: 'arb',
  polygon: 'polygon',
  matic: 'polygon',
};

export function normalizeChainId(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const key = hint.trim().toLowerCase().replace(/^#/, '');
  return CHAIN_ALIASES[key] ?? null;
}

export interface ValidateAddressOptions {
  /** 链标识或别名；未提供时按地址形状推断（0x → eth，base58 → sol）。 */
  chainHint?: string | null;
}

export interface ValidateAddressResult {
  address: ContractAddressRecord | null;
  rejection: ContractAddressRejection | null;
}

/**
 * 校验单个地址。严格模式：形状不符、长度不符、校验和不符一律判定失败，
 * 未知链不猜测（Q123）。
 */
export function validateContractAddress(value: string, options: ValidateAddressOptions = {}): ValidateAddressResult {
  const candidate = value.trim();
  const hinted = normalizeChainId(options.chainHint ?? null);
  if (options.chainHint && !hinted) {
    return { address: null, rejection: 'unknown_chain' };
  }

  if (/^0x[0-9a-fA-F]+$/.test(candidate)) {
    const chain = hinted ?? 'eth';
    if (EVM_CHAIN_IDS.includes(chain as (typeof EVM_CHAIN_IDS)[number]) === false) {
      return { address: null, rejection: 'unknown_chain' };
    }
    if (candidate.length !== 42) {
      return { address: null, rejection: 'bad_format' };
    }
    if (!isValidChecksumAddress(candidate)) {
      return { address: null, rejection: 'bad_checksum' };
    }
    return { address: { chain, address: candidate }, rejection: null };
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate)) {
    const chain = hinted ?? SOLANA_CHAIN_ID;
    if (chain !== SOLANA_CHAIN_ID) {
      return { address: null, rejection: 'unknown_chain' };
    }
    const decoded = decodeBase58(candidate);
    if (!decoded || decoded.length !== 32) {
      return { address: null, rejection: 'bad_format' };
    }
    return { address: { chain: SOLANA_CHAIN_ID, address: candidate }, rejection: null };
  }

  return { address: null, rejection: 'bad_format' };
}

const EVM_CANDIDATE = /0x[0-9a-fA-F]{40}/g;
const BASE58_CANDIDATE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const CHAIN_MENTION = /\b(sol|solana|spl|eth|ethereum|erc20|bsc|bnb|bep20|base|arbitrum|arb|polygon|matic)\b/gi;

function snippetAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 24);
  const to = Math.min(text.length, end + 24);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

/** 在地址前后 48 个字符的窗口内找链提示；找不到返回 null（不猜链）。 */
function chainMentionNear(text: string, start: number, end: number): string | null {
  const from = Math.max(0, start - 48);
  const to = Math.min(text.length, end + 48);
  const window = text.slice(from, to);
  for (const match of window.matchAll(CHAIN_MENTION)) {
    const chain = normalizeChainId(match[0]);
    if (chain) return chain;
  }
  return null;
}

/**
 * 从报告正文里提取 CA。返回第一个通过严格校验的地址；
 * 未通过时给出拒绝原因与原文片段，供人工判断（Q119）。
 */
export function extractContractAddress(reportText: string): ContractAddressExtraction {
  interface Candidate {
    raw: string;
    start: number;
    end: number;
    order: number;
  }

  const candidates: Candidate[] = [];
  for (const match of reportText.matchAll(EVM_CANDIDATE)) {
    candidates.push({ raw: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, order: match.index ?? 0 });
  }
  for (const match of reportText.matchAll(BASE58_CANDIDATE)) {
    const raw = match[0];
    // 排除 EVM 地址尾部被 base58 正则误匹配的情况。
    if (/^[0-9a-fA-F]{40}$/.test(raw)) continue;
    candidates.push({ raw, start: match.index ?? 0, end: (match.index ?? 0) + raw.length, order: match.index ?? 0 });
  }
  candidates.sort((a, b) => a.order - b.order);

  if (candidates.length === 0) {
    return { contractAddress: null, rawSnippet: null, rejection: 'no_candidate' };
  }

  let firstRejection: ContractAddressRejection | null = null;
  for (const candidate of candidates) {
    // 链提示只取该地址附近窗口里出现的链词，避免整篇报告的其他链名串台。
    const hintedChain = chainMentionNear(reportText, candidate.start, candidate.end);
    const result = validateContractAddress(candidate.raw, { chainHint: hintedChain });
    if (result.address) {
      return {
        contractAddress: result.address,
        rawSnippet: snippetAround(reportText, candidate.start, candidate.end),
        rejection: null,
      };
    }
    firstRejection ??= result.rejection;
  }

  return {
    contractAddress: null,
    rawSnippet: snippetAround(reportText, candidates[0]!.start, candidates[0]!.end),
    rejection: firstRejection ?? 'bad_format',
  };
}

/** 生成随机 EVM 地址（仅供测试与合成数据使用）。 */
export function checksumAddressFromHex(hex: string): string {
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error('expect 40 hex characters');
  }
  return toChecksumAddress(`0x${hex}`);
}
