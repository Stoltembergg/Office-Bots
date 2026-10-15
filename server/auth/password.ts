import { createHash, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): Buffer {
  return createHash('sha256').update(password, 'utf8').digest();
}

export function passwordsEqual(a: string, b: string): boolean {
  return timingSafeEqual(hashPassword(a), hashPassword(b));
}
