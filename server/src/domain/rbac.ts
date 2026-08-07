/**
 * RBAC + tenancy isolation — pure decisions, no I/O.
 *
 * Tiers:
 *  - global_admin: whole deployment, any org. Not tied to an org (orgId null).
 *  - org_admin:    manages users/IdP inside their own org only; is also a
 *                  normal board user within that org.
 *  - user:         boards/cards in their own org, membership-gated.
 *
 * Every decision that touches an org-scoped resource goes through these
 * functions; services must never query cross-org data without them.
 */
import type { Role } from '@kan-do/shared';

export interface Actor {
  userId: string;
  role: Role;
  orgId: string | null;
}

export interface BoardAccessInput {
  orgId: string;
  memberIds: readonly string[];
}

/** Tenancy gate: may the actor touch resources belonging to `resourceOrgId`? */
export function sameTenant(actor: Actor, resourceOrgId: string): boolean {
  if (actor.role === 'global_admin') return true;
  return actor.orgId !== null && actor.orgId === resourceOrgId;
}

/** Manage orgs themselves (create/suspend/delete, assign org admins). */
export function canManageOrgs(actor: Actor): boolean {
  return actor.role === 'global_admin';
}

/** Manage users (invite, deactivate, role-assign) within one org. */
export function canManageOrgUsers(actor: Actor, orgId: string): boolean {
  if (actor.role === 'global_admin') return true;
  return actor.role === 'org_admin' && actor.orgId === orgId;
}

/** Configure the org's IdP (SSO/SAML/OIDC). */
export function canManageIdp(actor: Actor, orgId: string): boolean {
  return canManageOrgUsers(actor, orgId);
}

export type BoardLevel = 'view' | 'edit' | 'admin';

/**
 * Board access. Global admins can observe any board (spec: observe/manage any
 * org) but board content editing stays membership-based for everyone in-org.
 */
export function canAccessBoard(actor: Actor, board: BoardAccessInput, level: BoardLevel): boolean {
  if (actor.role === 'global_admin') return level === 'view' || level === 'admin';
  if (!sameTenant(actor, board.orgId)) return false;
  return board.memberIds.includes(actor.userId);
}

/** Cards inherit board access: any board member may edit cards. */
export function canEditCards(actor: Actor, board: BoardAccessInput): boolean {
  if (actor.role === 'global_admin') return false; // observe, don't touch user content
  return canAccessBoard(actor, board, 'edit');
}

export function canCreateBoard(actor: Actor, orgId: string): boolean {
  return actor.role !== 'global_admin' && sameTenant(actor, orgId);
}

/** Only the user themself changes their notification settings/profile. */
export function canEditUserSettings(actor: Actor, targetUserId: string): boolean {
  return actor.userId === targetUserId;
}
