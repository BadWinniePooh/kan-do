import { initialsOf } from '@kan-do/shared';
import type { OwnerRow } from '../types';

/**
 * Registered users: solid circle, avatar image or initials.
 * External owners: dashed-border square-ish badge — visually distinct because
 * they cannot log in or hold SSO identities.
 */
export default function OwnerBadge({ owner, size = 7 }: { owner: OwnerRow; size?: number }) {
  const px = size * 4;
  if (owner.kind === 'user') {
    const name = owner.user_name ?? '?';
    return owner.user_avatar ? (
      <img
        src={owner.user_avatar}
        alt={`Owner: ${name}`}
        title={name}
        className="rounded-full object-cover ring-1 ring-white"
        style={{ width: px, height: px }}
      />
    ) : (
      <span
        role="img"
        aria-label={`Owner: ${name}`}
        title={name}
        className="rounded-full bg-blue-600 text-white flex items-center justify-center font-semibold ring-1 ring-white"
        style={{ width: px, height: px, fontSize: px * 0.38 }}
      >
        {initialsOf(name)}
      </span>
    );
  }
  const name = owner.external_name ?? '?';
  return (
    <span
      role="img"
      aria-label={`External owner (no account): ${name}`}
      title={`${name} (external)`}
      className="rounded-md bg-amber-100 text-amber-900 border-2 border-dashed border-amber-500 flex items-center justify-center font-semibold"
      style={{ width: px, height: px, fontSize: px * 0.34 }}
    >
      {initialsOf(name)}
    </span>
  );
}
