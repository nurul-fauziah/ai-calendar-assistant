import { encryptToken, decryptToken } from './crypto.util';

describe('crypto.util', () => {
  it('round-trips a token', () => {
    const t = 'ya29.token-value';
    expect(decryptToken(encryptToken(t, 'key'), 'key')).toBe(t);
  });

  it('uses explicit key over dev default', () => {
    const a = encryptToken('x', 'key-a');
    const b = encryptToken('x', 'key-b');
    expect(a).not.toBe(b);
    expect(() => decryptToken(a, 'key-b')).toThrow();
  });

  it('rejects malformed stored value', () => {
    expect(() => decryptToken('not-encrypted')).toThrow();
  });
});