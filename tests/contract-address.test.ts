import { describe, expect, it } from 'vitest';
import {
  decodeBase58,
  extractContractAddress,
  isValidChecksumAddress,
  keccak256,
  normalizeChainId,
  toChecksumAddress,
  validateContractAddress
} from '../shared/contract-address.js';

/** EIP-55 官方参考向量。 */
const EIP55_VECTORS = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'
];

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('Keccak-256 与地址校验和', () => {
  it('空输入的 Keccak-256 与已知向量一致', () => {
    expect(hex(keccak256(new Uint8Array(0)))).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });

  it('EIP-55 参考向量可以还原', () => {
    for (const vector of EIP55_VECTORS) {
      expect(toChecksumAddress(vector.toLowerCase()), vector).toBe(vector);
      expect(isValidChecksumAddress(vector), vector).toBe(true);
    }
  });

  it('全小写与全大写地址视为未提供校验和，仍然合法', () => {
    expect(isValidChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(true);
    expect(isValidChecksumAddress('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED')).toBe(true);
  });

  it('大小写错误的地址判定为校验和不符', () => {
    const broken = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
    expect(isValidChecksumAddress(broken)).toBe(false);
  });
});

describe('CA 校验（Q119、Q123、Q128）', () => {
  it('接受校验和正确的 EVM 地址并推断链', () => {
    const result = validateContractAddress(EIP55_VECTORS[0]!);
    expect(result.rejection).toBeNull();
    expect(result.address).toEqual({ chain: 'eth', address: EIP55_VECTORS[0] });
  });

  it('按链提示校验并保留链标识', () => {
    expect(validateContractAddress(EIP55_VECTORS[1]!, { chainHint: 'bsc' }).address).toEqual({
      chain: 'bsc',
      address: EIP55_VECTORS[1]
    });
    expect(validateContractAddress(EIP55_VECTORS[1]!, { chainHint: 'BNB' }).address?.chain).toBe('bsc');
  });

  it('拒绝大小写错误的 EVM 地址与长度不符的地址', () => {
    const badChecksum = validateContractAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD');
    expect(badChecksum.address).toBeNull();
    expect(badChecksum.rejection).toBe('bad_checksum');

    const shortAddress = validateContractAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA');
    expect(shortAddress.address).toBeNull();
    expect(shortAddress.rejection).toBe('bad_format');
  });

  it('接受 32 字节的 Solana 地址，拒绝长度不符的 base58', () => {
    const decoded = decodeBase58(USDC_MINT);
    expect(decoded?.length).toBe(32);
    expect(validateContractAddress(USDC_MINT).address).toEqual({ chain: 'sol', address: USDC_MINT });

    const tooShort = validateContractAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyT');
    expect(tooShort.address).toBeNull();
  });

  it('未知链不猜测，直接判失败', () => {
    const unknownChain = validateContractAddress(EIP55_VECTORS[0]!, { chainHint: 'dogechain' });
    expect(unknownChain.address).toBeNull();
    expect(unknownChain.rejection).toBe('unknown_chain');

    const mismatch = validateContractAddress(USDC_MINT, { chainHint: 'bsc' });
    expect(mismatch.rejection).toBe('unknown_chain');
  });

  it('链别名归一化', () => {
    expect(normalizeChainId('Solana')).toBe('sol');
    expect(normalizeChainId('ETH')).toBe('eth');
    expect(normalizeChainId('bep20')).toBe('bsc');
    expect(normalizeChainId('unknownchain')).toBeNull();
  });
});

describe('从报告文本提取 CA', () => {
  it('提取校验和地址并给出附近原文片段', () => {
    const text = `## 4. 合约信息\n本项目合约地址为 ${EIP55_VECTORS[0]}（以太坊主网）。`;
    const result = extractContractAddress(text);
    expect(result.contractAddress).toEqual({ chain: 'eth', address: EIP55_VECTORS[0] });
    expect(result.rawSnippet).toContain(EIP55_VECTORS[0]);
    expect(result.rejection).toBeNull();
  });

  it('报告里没有地址时返回 no_candidate', () => {
    const result = extractContractAddress('## 1. 项目概览\n该项目尚未发行代币。');
    expect(result.contractAddress).toBeNull();
    expect(result.rejection).toBe('no_candidate');
    expect(result.rawSnippet).toBeNull();
  });

  it('地址校验失败时不建 CA，但保留原文片段供人工判断', () => {
    const broken = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
    const result = extractContractAddress(`疑似合约：${broken}，请人工确认。`);
    expect(result.contractAddress).toBeNull();
    expect(result.rejection).toBe('bad_checksum');
    expect(result.rawSnippet).toContain(broken);
  });

  it('按附近链提示选择 Solana 地址', () => {
    const text = `Solana 链合约：${USDC_MINT}`;
    const result = extractContractAddress(text);
    expect(result.contractAddress).toEqual({ chain: 'sol', address: USDC_MINT });
  });
});
