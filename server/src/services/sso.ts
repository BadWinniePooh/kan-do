/**
 * SSO: OIDC + SAML against per-org IdP configs stored in idp_configs — adding
 * or changing an IdP is a config/DB change, never a code change.
 * Users are JIT-provisioned on first SSO login (role 'user').
 */
import * as oidc from 'openid-client';
import { SAML } from '@node-saml/node-saml';
import type { AppCtx } from './context.js';
import { badRequest, notFound } from './context.js';
import { config } from '../config.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes?: string;
}

export interface SamlConfig {
  entryPoint: string;
  issuer: string;
  cert: string;
}

async function idpFor(ctx: AppCtx, orgSlug: string, type: 'oidc' | 'saml') {
  const org = await ctx.db.selectFrom('organizations').select(['id', 'slug', 'active']).where('slug', '=', orgSlug).executeTakeFirst();
  if (!org || !org.active) throw notFound('organization');
  const idp = await ctx.db
    .selectFrom('idp_configs')
    .selectAll()
    .where('org_id', '=', org.id)
    .where('type', '=', type)
    .where('enabled', '=', true)
    .executeTakeFirst();
  if (!idp) throw badRequest(`no enabled ${type} IdP configured for this organization`);
  return { org, idp };
}

export async function jitProvision(ctx: AppCtx, orgId: string, email: string, displayName: string) {
  const existing = await ctx.db
    .selectFrom('users')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  if (existing) {
    if (!existing.active) throw badRequest('account is deactivated');
    return existing;
  }
  return ctx.db
    .insertInto('users')
    .values({ org_id: orgId, email: email.toLowerCase(), display_name: displayName, role: 'user' })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ---------- OIDC ----------

async function discover(cfg: OidcConfig): Promise<oidc.Configuration> {
  return oidc.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret);
}

export async function oidcStart(ctx: AppCtx, orgSlug: string): Promise<{ url: string; state: string; verifier: string }> {
  const { idp } = await idpFor(ctx, orgSlug, 'oidc');
  const cfg = idp.config as OidcConfig;
  const conf = await discover(cfg);
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(conf, {
    redirect_uri: `${config.publicUrl}/api/auth/oidc/${orgSlug}/callback`,
    scope: cfg.scopes ?? 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: url.href, state, verifier };
}

export async function oidcCallback(
  ctx: AppCtx,
  orgSlug: string,
  currentUrl: string,
  state: string,
  verifier: string,
) {
  const { org, idp } = await idpFor(ctx, orgSlug, 'oidc');
  const cfg = idp.config as OidcConfig;
  const conf = await discover(cfg);
  const tokens = await oidc.authorizationCodeGrant(conf, new URL(currentUrl), {
    expectedState: state,
    pkceCodeVerifier: verifier,
  });
  const claims = tokens.claims();
  const email = claims?.email as string | undefined;
  if (!email) throw badRequest('IdP did not return an email claim');
  const name = (claims?.name as string | undefined) ?? email.split('@')[0]!;
  return jitProvision(ctx, org.id, email, name);
}

// ---------- SAML ----------

function samlFor(cfg: SamlConfig, orgSlug: string): SAML {
  return new SAML({
    entryPoint: cfg.entryPoint,
    issuer: cfg.issuer,
    callbackUrl: `${config.publicUrl}/api/auth/saml/${orgSlug}/callback`,
    idpCert: cfg.cert,
    wantAssertionsSigned: true,
    audience: cfg.issuer,
  });
}

export async function samlStart(ctx: AppCtx, orgSlug: string): Promise<string> {
  const { idp } = await idpFor(ctx, orgSlug, 'saml');
  const saml = samlFor(idp.config as SamlConfig, orgSlug);
  return saml.getAuthorizeUrlAsync('', undefined, {});
}

export async function samlCallback(ctx: AppCtx, orgSlug: string, body: Record<string, string>) {
  const { org, idp } = await idpFor(ctx, orgSlug, 'saml');
  const saml = samlFor(idp.config as SamlConfig, orgSlug);
  const { profile } = await saml.validatePostResponseAsync(body);
  const email = (profile?.email ?? profile?.nameID) as string | undefined;
  if (!email) throw badRequest('SAML response missing email/nameID');
  const name = (profile?.displayName as string | undefined) ?? email.split('@')[0]!;
  return jitProvision(ctx, org.id, email, name);
}
