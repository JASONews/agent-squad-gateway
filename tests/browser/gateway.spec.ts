import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type GatewayHarness } from './fixtures.js';

async function openGateway(page: Page, gateway: GatewayHarness, path: string): Promise<void> {
  await page.goto(`${gateway.baseURL}/#${path}`);
  await expect(page.locator('.app-shell')).toBeVisible();
}

async function expectContainedLayout(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    tableWrappers: [...document.querySelectorAll<HTMLElement>('.data-table-wrap')].map((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    })),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  for (const wrapper of layout.tableWrappers) {
    if (wrapper.scrollWidth > wrapper.clientWidth) {
      expect(['auto', 'scroll']).toContain(wrapper.overflowX);
    }
  }
}

async function captureQa(page: Page, name: string): Promise<void> {
  if (process.env.GATEWAY_CAPTURE_SCREENSHOTS !== '1') return;
  await page.screenshot({
    path: join(tmpdir(), `agent-squad-gateway-${name}.png`),
    fullPage: true,
  });
}

test('language selector switches and persists the localized UI', async ({ page, gateway }) => {
  await openGateway(page, gateway, '/overview');

  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN');
  expect(await page.locator('html').getAttribute('lang')).toBe('zh-CN');
  expect(await page.evaluate(() => localStorage.getItem('asq_gateway_language'))).toBe('zh-CN');
  await expectContainedLayout(page);

  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  expect(await page.locator('html').getAttribute('lang')).toBe('en');
  await expectContainedLayout(page);
});

test('desktop navigation reveals a seeded client key without page overflow', async ({ page, gateway }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await openGateway(page, gateway, '/overview');
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1440, 900]);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await captureQa(page, 'desktop-overview');

  const clientsLink = page.getByRole('link', { name: 'Clients and Keys' });
  await clientsLink.focus();
  await expect(clientsLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Clients and Keys' })).toBeVisible();
  await page.getByRole('link', { name: gateway.seed.clientName }).click();
  await expect(page.getByRole('heading', { name: gateway.seed.clientName })).toBeVisible();

  await page.getByRole('button', { name: 'Reveal key Browser primary key' }).click();
  await expect(page.getByRole('textbox', { name: 'Key Browser primary key' })).toHaveValue(gateway.seed.apiKey);
  await expectContainedLayout(page);
  await captureQa(page, 'desktop-clients');

  await openGateway(page, gateway, '/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expectContainedLayout(page);
  await captureQa(page, 'desktop-settings');
});

test('wide desktop centers the topbar and page content in the workspace', async ({ page, gateway }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.setViewportSize({ width: 1920, height: 900 });
  await openGateway(page, gateway, '/overview');

  const layout = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>('.workspace')!.getBoundingClientRect();
    const topbar = document.querySelector<HTMLElement>('.topbar__content')!.getBoundingClientRect();
    const content = document.querySelector<HTMLElement>('.page')!.getBoundingClientRect();
    return {
      workspace: { left: workspace.left, right: workspace.right },
      topbar: { left: topbar.left, right: topbar.right, width: topbar.width },
      content: { left: content.left, right: content.right, width: content.width },
    };
  });

  expect(layout.topbar.width).toBe(1440);
  expect(layout.content.width).toBe(1440);
  expect(layout.topbar.left - layout.workspace.left)
    .toBeCloseTo(layout.workspace.right - layout.topbar.right, 5);
  expect(layout.content.left - layout.workspace.left)
    .toBeCloseTo(layout.workspace.right - layout.content.right, 5);
  await expectContainedLayout(page);
  await captureQa(page, 'desktop-wide-overview');
});

test('Core session detail exposes raw tail, focus trapping, Escape, and reduced motion', async ({ page, gateway }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await openGateway(page, gateway, '/core/sessions');
  await expect(page.getByRole('heading', { name: 'Core Sessions' })).toBeVisible();
  await page.getByRole('link', { name: gateway.seed.rootTask }).click();
  await expect(page.getByRole('heading', { name: gateway.seed.rootTask })).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  const messageRoute = page.locator('.core-message__route').first();
  await expect(messageRoute).toHaveAttribute('aria-label', /reviewer-with-an-intentionally-long-alias to Main agent/);
  await expect(messageRoute).toContainText('reviewer-with-an-intentionally-long-alias');
  await expect(messageRoute).toContainText('fake');
  await expect(messageRoute).toContainText('Main agent');
  await expectContainedLayout(page);
  await captureQa(page, 'desktop-core-session');

  const rawTailButton = page.getByRole('button', { name: /View raw tail/ });
  await rawTailButton.click();
  const dialog = page.getByRole('dialog', { name: /Raw tail:/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await expect(dialog.locator('pre')).toContainText('unbroken-gateway');
  await expectContainedLayout(page);
  await captureQa(page, 'desktop-core-raw-tail');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(rawTailButton).toBeFocused();
  await expectContainedLayout(page);
});

test('target verification requires explicit confirmation and stays on FakeProvider', async ({ page, gateway }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  let releaseVerification: () => void = () => {};
  const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
  await page.route('**/admin/targets/*/verify', async (route) => {
    await verificationGate;
    await route.continue();
  });
  await openGateway(page, gateway, '/targets');
  await expect(page.getByRole('heading', { name: 'Invocation Targets' })).toBeVisible();
  expect(gateway.conformanceProbeCount()).toBe(0);

  await page.getByRole('button', { name: `Verify ${gateway.seed.targetId}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Verify target' });
  await expect(dialog).toContainText('may consume quota');
  expect(gateway.conformanceProbeCount()).toBe(0);
  await dialog.getByRole('button', { name: 'Verify target' }).click();
  await expect(dialog.getByRole('status')).toContainText('Verification in progress');
  await expect(dialog.getByRole('button', { name: 'Verifying...' })).toHaveAttribute('aria-busy', 'true');
  await captureQa(page, 'desktop-target-verifying');
  await dialog.getByRole('button', { name: 'Hide' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: `Verifying ${gateway.seed.targetId}` })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText(`Verifying target ${gateway.seed.targetId}`);
  releaseVerification();
  await expect(page.getByRole('button', { name: `Verify ${gateway.seed.targetId}` })).toBeEnabled();
  expect(gateway.conformanceProbeCount()).toBe(1);
  const enabledSwitch = page.getByRole('switch', { name: `Enable ${gateway.seed.targetId}` });
  await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
  await enabledSwitch.focus();
  await page.keyboard.press('Space');
  await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
  await captureQa(page, 'desktop-target-toggle-on');
  await enabledSwitch.focus();
  await page.keyboard.press('Space');
  await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
  await expectContainedLayout(page);
  await captureQa(page, 'desktop-targets');
});

test('target editor exposes required choices, custom fallback, and validation feedback', async ({ page, gateway }, testInfo) => {
  await openGateway(page, gateway, '/targets');
  await page.getByRole('button', { name: 'Create target' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create target' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: /^CLI/ })).toHaveValue('codex');
  await expect(dialog.getByRole('combobox', { name: /^Native model/ })).toHaveValue('__custom__');
  await expect(dialog.getByRole('textbox', { name: /^Custom native model/ })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: /^Reasoning effort/ })).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: /^Max concurrency/ })).toHaveValue('1');
  await expect(dialog.getByRole('combobox', { name: /^Workspace/ })).toHaveValue('managed');

  await dialog.getByRole('button', { name: 'Create and verify' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Select a native model or enter a custom model.');
  await expectContainedLayout(page);
  await captureQa(page, `${testInfo.project.name}-target-editor`);
});

test('target editor displays the effective model profile', async ({ page, gateway }, testInfo) => {
  await openGateway(page, gateway, '/targets');
  await page.getByRole('button', { name: `Edit ${gateway.seed.targetId}` }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit target' });
  const profile = dialog.getByRole('region', { name: 'Model profile' });
  await expect(profile).toContainText('Browser provider high-effort profile.');
  await expect(profile).toContainText('Deterministic browser testing');
  await expect(profile).toContainText('Priority: 91');
  await expect(profile).toContainText('User override');
  await expectContainedLayout(page);
  await captureQa(page, `${testInfo.project.name}-target-model-profile`);
});

test('run cancellation confirms the selected seeded run', async ({ page, gateway }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await openGateway(page, gateway, '/runs');
  const cancelButton = page.getByRole('button', { name: `Cancel run ${gateway.seed.runId}` });
  const row = page.getByRole('row').filter({ hasText: gateway.seed.targetId });
  await expect(row).toContainText('running');
  await cancelButton.click();
  const dialog = page.getByRole('dialog', { name: 'Cancel API run' });
  await expect(dialog.getByRole('button', { name: 'Keep running' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Confirm cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('cancelled');
  await expectContainedLayout(page);
  await captureQa(page, 'desktop-runs');
});

test('multiple Core choices resolve one recommended decision with rationale', async ({ page, gateway }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await openGateway(page, gateway, '/core/choices');
  await expect(page.getByText('2 pending')).toBeVisible();
  await page.getByRole('button', { name: `Resolve ${gateway.seed.primaryChoiceQuestion}` }).click();
  const dialog = page.getByRole('dialog', { name: gateway.seed.primaryChoiceQuestion });
  const options = dialog.getByRole('radio');
  await expect(options).toHaveCount(3);
  await expect(options.first()).toBeFocused();
  await dialog.getByRole('radio', { name: /Staged rollout/ }).check();
  await dialog.getByRole('textbox', { name: 'Rationale' }).fill('Keep rollout bounded and observable.');
  await captureQa(page, 'desktop-choices');
  await dialog.getByRole('button', { name: 'Submit choice' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('1 pending')).toBeVisible();
  expect(gateway.core.resolvedPrimaryChoice).toEqual({
    selected: 'balanced',
    rationale: 'Keep rollout bounded and observable.',
  });
});

test('Core SSE refreshes sessions and recovers through offline Retry Core', async ({ page, gateway }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await openGateway(page, gateway, '/core/sessions');
  await expect(page.getByText('Core connected')).toBeVisible();

  const added = gateway.core.addSseSession();
  gateway.core.emitSessionUpdate(added.id);
  await expect(page.getByRole('link', { name: added.root_task })).toBeVisible();

  await gateway.core.setOnline(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Core is offline' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry Core' }).click();
  await expect(page.getByRole('heading', { name: 'Core is offline' })).toBeVisible();
  await gateway.core.setOnline(true);
  await expect(page.getByRole('link', { name: added.root_task })).toBeVisible();
  await expect(page.getByText('Core connected')).toBeVisible();
  await expectContainedLayout(page);
  await captureQa(page, 'desktop-core-sessions');
});

test('Core session history paginates with newest sessions first', async ({ page, gateway }, testInfo) => {
  const history = gateway.core.addSessionHistory(23);
  const newest = history.at(-1)!;
  const oldest = history[0]!;

  try {
    await openGateway(page, gateway, '/core/sessions');

    await expect(page.getByRole('link', { name: newest.root_task, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: oldest.root_task, exact: true })).toBeHidden();
    await expect(page.getByText('Page 1 of 2')).toBeVisible();
    await expectContainedLayout(page);

    await page.getByRole('button', { name: 'Next page' }).click();

    await expect(page.getByRole('link', { name: oldest.root_task, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: newest.root_task, exact: true })).toBeHidden();
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await expectContainedLayout(page);
    await captureQa(page, `${testInfo.project.name}-core-pagination`);
  } finally {
    gateway.core.removeSessionHistory();
  }
});

test('mobile drawer and session tabs keep long content contained and keyboard accessible', async ({ page, gateway }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile');
  await openGateway(page, gateway, '/overview');
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([390, 844]);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

  const navigation = page.locator('nav[aria-label="Gateway"]');
  await expect(navigation).toHaveAttribute('inert', '');
  const menuButton = page.getByRole('button', { name: 'Open navigation' });
  await menuButton.click();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.closest('nav') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(navigation).toHaveAttribute('inert', '');

  await menuButton.click();
  await navigation.getByRole('link', { name: 'Core Sessions' }).click();
  await expect(page.getByRole('heading', { name: 'Core Sessions' })).toBeVisible();
  await expectContainedLayout(page);
  await page.getByRole('link', { name: gateway.seed.rootTask }).click();
  const messageRoute = page.locator('.core-message__route').first();
  await expect(messageRoute).toHaveAttribute('aria-label', /reviewer-with-an-intentionally-long-alias to Main agent/);
  await expectContainedLayout(page);
  await captureQa(page, 'mobile-core-session');
  const messagesTab = page.getByRole('tab', { name: 'Messages' });
  const subagentsTab = page.getByRole('tab', { name: 'Subagents' });
  await messagesTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(subagentsTab).toBeFocused();
  await expect(subagentsTab).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: /View raw tail/ }).click();
  const dialog = page.getByRole('dialog', { name: /Raw tail:/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('pre')).toContainText('unbroken-gateway');
  await expectContainedLayout(page);
  await captureQa(page, 'mobile-core-raw-tail');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expectContainedLayout(page);
});
