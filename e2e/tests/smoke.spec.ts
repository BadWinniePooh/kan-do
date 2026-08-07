/**
 * Smoke-level e2e: core board/card flow + org-admin bootstrap flow.
 *
 * Data hygiene rules (the point of this file's structure):
 *  - setup creates a DEDICATED org with a unique slug for this run; every
 *    action happens inside it — nothing ever touches "whichever org exists".
 *  - teardown deletes that org (FK cascade removes its users/boards/cards),
 *    pass or fail, so no residue is left in the target deployment.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const ORG_SLUG = `smoke-${RUN}`;
const ORG_NAME = `Smoke Org ${RUN}`;
const USER_EMAIL = `smoke-${RUN}@test.io`;
const USER_PASSWORD = 'smokepass1';
const ORGADMIN_EMAIL = `orgadmin-${RUN}@test.io`;

let orgId: string;
let adminCookie: string;

test.describe.configure({ mode: 'serial' });

async function apiLogin(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { email, password } });
  expect(res.ok(), `login as ${email}`).toBe(true);
  const setCookie = res.headers()['set-cookie']!;
  return setCookie.split(';')[0]!;
}

test.beforeAll(async ({ request }) => {
  adminCookie = await apiLogin(request, ADMIN_EMAIL, ADMIN_PASSWORD);
  const created = await request.post('/api/admin/orgs', {
    headers: { cookie: adminCookie },
    data: { name: ORG_NAME, slug: ORG_SLUG },
  });
  expect(created.ok(), 'dedicated smoke org must be created').toBe(true);
  orgId = (await created.json()).id;

  const user = await request.post(`/api/orgs/${orgId}/users`, {
    headers: { cookie: adminCookie },
    data: { email: USER_EMAIL, displayName: 'Smoke Tester', password: USER_PASSWORD },
  });
  expect(user.ok(), 'smoke user must be created inside the smoke org').toBe(true);
});

test.afterAll(async ({ request }) => {
  // teardown runs pass or fail; deleting the org cascades to all test data
  if (!orgId) return;
  const cookie = adminCookie ?? (await apiLogin(request, ADMIN_EMAIL, ADMIN_PASSWORD));
  const res = await request.delete(`/api/admin/orgs/${orgId}`, { headers: { cookie } });
  expect(res.ok(), 'smoke org teardown').toBe(true);
});

test('global admin creates an ORG ADMIN via UI (scoped to the smoke org); org admin sees admin nav', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();

  // strictly target OUR org's row — never .first()
  const orgRow = page.getByRole('row', { name: new RegExp(ORG_SLUG) });
  await orgRow.getByRole('button', { name: 'Manage users' }).click();

  const form = page.locator('form[aria-label="Create user in organization"]');
  await form.getByLabel('Email').fill(ORGADMIN_EMAIL);
  await form.getByLabel('Display name').fill('E2E OrgAdmin');
  await form.getByLabel('Initial password (min 8)').fill('e2epassword1');
  await form.getByLabel('Role').selectOption('org_admin');
  await form.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('cell', { name: ORGADMIN_EMAIL })).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(ORGADMIN_EMAIL);
  await page.getByLabel('Password').fill('e2epassword1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Org Admin' })).toBeVisible();
});

test('user logs in, creates board, adds and opens a card', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(USER_EMAIL);
  await page.getByLabel('Password').fill(USER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
  const boardName = `Smoke board ${RUN}`;
  await page.getByLabel('New board name').fill(boardName);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('link', { name: boardName }).click();

  await expect(page.getByRole('heading', { name: 'Open' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();

  await page.getByLabel('Add card to Open').click();
  await page.getByPlaceholder('Card title, Enter to add').fill('Water the plants');
  await page.keyboard.press('Enter');
  const card = page.getByRole('button', { name: /Card: Water the plants/ });
  await expect(card).toBeVisible();

  await card.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('New note (markdown supported)').fill('**remember** the balcony');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('remember')).toBeVisible();
  await page.getByLabel('Close card').click();
});
