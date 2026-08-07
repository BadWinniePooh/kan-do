import { describe, it, expect } from 'vitest';
import {
  sameTenant,
  canManageOrgs,
  canManageOrgUsers,
  canManageIdp,
  canAccessBoard,
  canEditCards,
  canCreateBoard,
  canEditUserSettings,
  type Actor,
} from './rbac.js';

const globalAdmin: Actor = { userId: 'ga', role: 'global_admin', orgId: null };
const orgAdminA: Actor = { userId: 'oa', role: 'org_admin', orgId: 'orgA' };
const userA: Actor = { userId: 'u1', role: 'user', orgId: 'orgA' };
const userB: Actor = { userId: 'u2', role: 'user', orgId: 'orgB' };

const boardA = { orgId: 'orgA', memberIds: ['u1', 'oa'] };
const boardB = { orgId: 'orgB', memberIds: ['u2'] };

describe('tenancy isolation', () => {
  it('user cannot touch another org', () => {
    expect(sameTenant(userA, 'orgB')).toBe(false);
    expect(sameTenant(userB, 'orgA')).toBe(false);
  });
  it('org admin bound to own org', () => {
    expect(sameTenant(orgAdminA, 'orgA')).toBe(true);
    expect(sameTenant(orgAdminA, 'orgB')).toBe(false);
  });
  it('global admin crosses tenants', () => {
    expect(sameTenant(globalAdmin, 'orgA')).toBe(true);
    expect(sameTenant(globalAdmin, 'orgB')).toBe(true);
  });
  it('actor with null org matches nothing unless global admin', () => {
    const orphan: Actor = { userId: 'x', role: 'user', orgId: null };
    expect(sameTenant(orphan, 'orgA')).toBe(false);
  });
});

describe('org management', () => {
  it('only global admin manages orgs', () => {
    expect(canManageOrgs(globalAdmin)).toBe(true);
    expect(canManageOrgs(orgAdminA)).toBe(false);
    expect(canManageOrgs(userA)).toBe(false);
  });
});

describe('user management', () => {
  it('org admin manages own org users only', () => {
    expect(canManageOrgUsers(orgAdminA, 'orgA')).toBe(true);
    expect(canManageOrgUsers(orgAdminA, 'orgB')).toBe(false);
  });
  it('plain user never manages users, even own org', () => {
    expect(canManageOrgUsers(userA, 'orgA')).toBe(false);
  });
  it('global admin manages users in any org', () => {
    expect(canManageOrgUsers(globalAdmin, 'orgA')).toBe(true);
    expect(canManageOrgUsers(globalAdmin, 'orgB')).toBe(true);
  });
  it('IdP config follows the same rule', () => {
    expect(canManageIdp(orgAdminA, 'orgA')).toBe(true);
    expect(canManageIdp(orgAdminA, 'orgB')).toBe(false);
    expect(canManageIdp(userA, 'orgA')).toBe(false);
  });
});

describe('board access', () => {
  it('member can view and edit', () => {
    expect(canAccessBoard(userA, boardA, 'view')).toBe(true);
    expect(canAccessBoard(userA, boardA, 'edit')).toBe(true);
  });
  it('same-org non-member denied', () => {
    const outsider: Actor = { userId: 'u9', role: 'user', orgId: 'orgA' };
    expect(canAccessBoard(outsider, boardA, 'view')).toBe(false);
  });
  it('cross-tenant access attempt denied at every level', () => {
    for (const level of ['view', 'edit', 'admin'] as const) {
      expect(canAccessBoard(userA, boardB, level)).toBe(false);
      expect(canAccessBoard(userB, boardA, level)).toBe(false);
    }
  });
  it('org admin of same org still needs membership for boards', () => {
    const otherBoardA = { orgId: 'orgA', memberIds: ['u1'] };
    expect(canAccessBoard(orgAdminA, otherBoardA, 'view')).toBe(false);
  });
  it('global admin observes any board but does not edit cards', () => {
    expect(canAccessBoard(globalAdmin, boardB, 'view')).toBe(true);
    expect(canEditCards(globalAdmin, boardB)).toBe(false);
  });
});

describe('card editing', () => {
  it('board member edits cards', () => {
    expect(canEditCards(userA, boardA)).toBe(true);
  });
  it('cross-tenant card edit denied', () => {
    expect(canEditCards(userA, boardB)).toBe(false);
  });
});

describe('board creation', () => {
  it('users create boards only in own org', () => {
    expect(canCreateBoard(userA, 'orgA')).toBe(true);
    expect(canCreateBoard(userA, 'orgB')).toBe(false);
  });
  it('global admin does not own kanban content', () => {
    expect(canCreateBoard(globalAdmin, 'orgA')).toBe(false);
  });
});

describe('user settings', () => {
  it('self only', () => {
    expect(canEditUserSettings(userA, 'u1')).toBe(true);
    expect(canEditUserSettings(userA, 'u2')).toBe(false);
    expect(canEditUserSettings(orgAdminA, 'u1')).toBe(false);
  });
});
