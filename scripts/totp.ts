/** Prints the current TOTP code for a base32 secret: `npm run totp -- JBSWY3DPEHPK3PXP` (demo/testing helper). */
import { totpNow } from '../src/shared/totp';

const secret = process.argv[2];
if (!secret) {
  console.error('usage: npm run totp -- <base32-secret>');
  process.exit(1);
}
console.log(totpNow(secret));
