import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// AES-256-GCM. Token disimpan sebagai `${ivBase64}:${ctBase64}` — IV inline per
// nilai, jadi tanpa kolom tambahan & tanpa migration (tabel existing).
// ponytail: prod HARUS set TOKEN_ENCRYPTION_KEY di env. Dev key hanya agar
// flow tetap jalan di lokal; ganti dengan env + re-encrypt token existing
// sebelum dipakai nyata.
const keyBytes = (key?: string): Buffer => {
  if (key) return createHash('sha256').update(key).digest();
  return createHash('sha256').update('dev-token-encryption-key-change-me').digest();
};

export function encryptToken(plaintext: string, key?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${Buffer.concat([tag, ct]).toString('base64')}`;
}

export function decryptToken(stored: string, key?: string): string {
  const parts = stored.split(':');
  if (parts.length !== 2) throw new Error('Malformed encrypted token');
  const [ivB64, bodyB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const body = Buffer.from(bodyB64, 'base64');
  const tag = body.subarray(0, 16);
  const ct = body.subarray(16);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}