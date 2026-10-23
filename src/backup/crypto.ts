import { AppError } from '../contracts/errors';
import { LIMITS } from '../contracts/tables';

const MAGIC = 'DAIGANBK';
const ENVELOPE_VERSION = 1;
const KDF_PBKDF2_SHA256 = 1;
const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BITS = 128;
const HEADER_BYTES = MAGIC.length + 1 + 1 + 4 + 1 + SALT_BYTES + 1 + NONCE_BYTES;

export const CRYPTO_CONSTANTS = {
  iterations: ITERATIONS,
  saltBytes: SALT_BYTES,
  nonceBytes: NONCE_BYTES,
} as const;

function subtle(): SubtleCrypto {
  const cryptoLike = globalThis.crypto;
  if (!cryptoLike?.subtle) {
    throw new AppError('STORAGE_UNAVAILABLE', '当前浏览器不支持 Web Crypto');
  }
  return cryptoLike.subtle;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  if (password.length === 0) throw new AppError('BACKUP_PASSWORD', '密码不能为空');
  if (password.length > LIMITS.maxPasswordLength) {
    throw new AppError('BACKUP_PASSWORD', `密码最多 ${LIMITS.maxPasswordLength} 个字符`);
  }
  const encoder = new TextEncoder();
  const baseKey = await subtle().importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  let text = '';
  for (let index = 0; index < MAGIC.length; index += 1) text += String.fromCharCode(bytes[index]);
  return text === MAGIC;
}

export async function encryptArchive(plain: Uint8Array, password: string): Promise<Uint8Array> {
  const cryptoLike = globalThis.crypto;
  const salt = cryptoLike.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = cryptoLike.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await deriveKey(password, salt);
  const cipher = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: nonce as unknown as BufferSource, tagLength: TAG_BITS },
      key,
      plain as unknown as BufferSource,
    ),
  );

  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  let offset = 0;
  for (const char of MAGIC) header[offset++] = char.charCodeAt(0);
  header[offset++] = ENVELOPE_VERSION;
  header[offset++] = KDF_PBKDF2_SHA256;
  view.setInt32(offset, ITERATIONS, false);
  offset += 4;
  header[offset++] = SALT_BYTES;
  header.set(salt, offset);
  offset += SALT_BYTES;
  header[offset++] = NONCE_BYTES;
  header.set(nonce, offset);
  offset += NONCE_BYTES;

  const output = new Uint8Array(header.length + cipher.length);
  output.set(header, 0);
  output.set(cipher, header.length);
  return output;
}

export async function decryptArchive(
  envelope: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  if (!isEncryptedEnvelope(envelope)) {
    throw new AppError('BACKUP_FORMAT', '不是加密信封');
  }
  if (envelope.length < HEADER_BYTES + TAG_BITS / 8) {
    throw new AppError('BACKUP_FORMAT', '加密信封被截断');
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  let offset = MAGIC.length;
  const version = envelope[offset++];
  if (version !== ENVELOPE_VERSION) {
    throw new AppError('BACKUP_FORMAT', `不支持的加密信封版本：${version}`);
  }
  const kdf = envelope[offset++];
  if (kdf !== KDF_PBKDF2_SHA256) {
    throw new AppError('BACKUP_FORMAT', `不支持的密钥派生算法：${kdf}`);
  }
  const iterations = view.getInt32(offset, false);
  offset += 4;
  if (iterations !== ITERATIONS) {
    throw new AppError('BACKUP_FORMAT', `不支持的迭代次数：${iterations}`);
  }
  const saltLength = envelope[offset++];
  if (saltLength !== SALT_BYTES) throw new AppError('BACKUP_FORMAT', '盐长度不正确');
  const salt = envelope.slice(offset, offset + saltLength);
  offset += saltLength;
  const nonceLength = envelope[offset++];
  if (nonceLength !== NONCE_BYTES) throw new AppError('BACKUP_FORMAT', 'nonce 长度不正确');
  const nonce = envelope.slice(offset, offset + nonceLength);
  offset += nonceLength;
  const cipher = envelope.slice(offset);

  const key = await deriveKey(password, salt);
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: nonce as unknown as BufferSource, tagLength: TAG_BITS },
        key,
        cipher as unknown as BufferSource,
      ),
    );
  } catch {
    throw new AppError('BACKUP_PASSWORD', '密码错误或文件已损坏');
  }
}

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await subtle().digest('SHA-256', buffer as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
