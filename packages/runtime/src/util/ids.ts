import { randomBytes } from 'node:crypto';

/**
 * Identifier generation. Ids are unique per ledger (the ledger silently treats a repeated id as a
 * duplicate append, so a colliding id would lose an event): time prefix + 64 random bits.
 */
export type IdGen = (prefix: string) => string;

export const defaultIds: IdGen = (prefix) => `${prefix}_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;

/** 8 lowercase hex chars, used for business-case ids (`bc_<8 hex>`). */
export function hex8(): string {
  return randomBytes(4).toString('hex');
}
