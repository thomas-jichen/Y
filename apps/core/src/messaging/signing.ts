/** Ed25519 signing of owner instructions (y-oi-v1). Key from config, else one per process (dev). */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { ownerInstructionSigningMessage, type OwnerInstruction } from '@y/schema';
import type { CoreConfig } from '../contracts.js';

let cached: { key: KeyObject; kid: string; source: string | null } | null = null;

function signer(config: CoreConfig): { key: KeyObject; kid: string } {
  if (cached && cached.source === config.signingKeyPkcs8B64) return cached;
  const key = config.signingKeyPkcs8B64
    ? createPrivateKey({ key: Buffer.from(config.signingKeyPkcs8B64, 'base64'), format: 'der', type: 'pkcs8' })
    : generateKeyPairSync('ed25519').privateKey;
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const kid = `core-${createHash('sha256').update(spki).digest('hex').slice(0, 16)}`;
  cached = { key, kid, source: config.signingKeyPkcs8B64 };
  return cached;
}

export function signOwnerInstruction(
  config: CoreConfig,
  oi: Pick<OwnerInstruction, 'id' | 'agent_id' | 'thread_id' | 'body' | 'verified_via' | 'created_at'>,
): { kid: string; sig: string } {
  const s = signer(config);
  const sig = sign(null, Buffer.from(ownerInstructionSigningMessage(oi), 'utf8'), s.key).toString('base64url');
  return { kid: s.kid, sig };
}

/** Public key (SPKI DER, base64) for the keyring / tests. */
export function ownerInstructionPublicKey(config: CoreConfig): KeyObject {
  return createPublicKey(signer(config).key);
}
