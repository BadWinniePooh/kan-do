/**
 * Smoke-level e2e: the core board/card flow only, per the testing pyramid.
 * Runs against a full docker-compose stack (see CI e2e job).
 */
import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin1234';
const USER_EMAIL = 'smoke@test.io';
const USER_PASSWORD = 'smokepass1';

test.describe.configure({ mode: 'serial' });

test('global admin creates an org and a user', async ({ page, request }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();

  // idempotent seed via API using the admin session
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const orgs = await (await request.get('/api/admin/orgs', { headers: { cookie: cookieHeader } })).json();
  let org = orgs.find((o: { slug: string }) => o.slug === 'smoke-org');
  if (!org) {
    org = await (
      await request.post('/api/admin/orgs', {
        headers: { cookie: cookieHeader },
        data: { name: 'Smoke Org', slug: 'smoke-org' },
      })
    ).json();
  }
  const users = await (await request.get(`/api/orgs/${org.id}/users`, { headers: { cookie: cookieHeader } })).json();
  if (!users.some((u: { email: string }) => u.email === USER_EMAIL)) {
    const created = await request.post(`/api/orgs/${org.id}/users`, {
      headers: { cookie: cookieHeader },
      data: { email: USER_EMAIL, displayName: 'Smoke Tester', password: USER_PASSWORD },
    });
    expect(created.ok()).toBe(true);
  }
});

test('user logs in, creates board, adds and opens a card', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(USER_EMAIL);
  await page.getByLabel('Password').fill(USER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
  const boardName = `Smoke board ${Date.now()}`;
  await page.getByLabel('New board name').fill(boardName);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('link', { name: boardName }).click();

  // default columns exist, with open/done semantics visible
  await expect(page.getByRole('heading', { name: 'Open' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();

  await page.getByLabel('Add card to Open').click();
  await page.getByPlaceholder('Card title, Enter to add').fill('Water the plants');
  await page.keyboard.press('Enter');
  const card = page.getByRole('button', { name: /Card: Water the plants/ });
  await expect(card).toBeVisible();

  // expand the card, add a markdown note
  await card.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('New note (markdown supported)').fill('**remember** the balcony');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('remember')).toBeVisible();
  await page.getByLabel('Close card').click();
});
