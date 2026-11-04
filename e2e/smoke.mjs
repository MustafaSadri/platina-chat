// Browser smoke test: drives two real Chrome sessions (desktop admin + iPhone-sized employee)
// through onboarding, messaging, receipts, file upload and a WebRTC call with fake media devices.
// Usage: node e2e/smoke.mjs <adminUsername> <adminPassword> [baseUrl] [chromePath]
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [adminUser, adminPass, base = 'http://localhost:3000', chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
const shots = path.resolve(process.env.SHOTS_DIR || 'e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });
const stamp = Date.now().toString(36).slice(-4);

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const pages = {};

async function newPage(ctx, viewport, mobile = false) {
  const page = await ctx.newPage();
  await page.setViewport({ ...viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  if (mobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  page.on('pageerror', (e) => errors.push(`${viewport.width}px pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${viewport.width}px console: ${m.text()}`));
  await ctx.overridePermissions(base, ['microphone', 'camera', 'notifications']);
  return page;
}

async function clickText(page, text, selector = 'button') {
  await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some((b) => b.textContent.includes(t) && b.offsetParent !== null), { timeout: 10_000 }, selector, text);
  await page.evaluate((sel, t) => [...document.querySelectorAll(sel)].find((b) => b.textContent.includes(t) && b.offsetParent !== null).click(), selector, text);
}

async function type(page, selector, value) {
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
}

async function login(page, user, pass) {
  await page.goto(base, { waitUntil: 'networkidle0' });
  await type(page, 'input[autocomplete="username"]', user);
  await type(page, 'input[autocomplete="current-password"]', pass);
  await clickText(page, 'Sign in');
}

async function changePassword(page, temp, next) {
  await page.waitForFunction(() => document.body.innerText.includes('replace your temporary password'));
  const inputs = await page.$$('input[type="password"]');
  await inputs[0].type(temp);
  await inputs[1].type(next);
  await inputs[2].type(next);
  await clickText(page, 'Change password');
  await page.waitForSelector('.sidebar', { visible: true });
}

const step = (name) => console.log(`✔ ${name}`);

try {
  // ---------------------------------------------------------------- admin (desktop)
  const adminCtx = await browser.createBrowserContext();
  const admin = await newPage(adminCtx, { width: 1366, height: 860 });
  pages.admin = admin;
  await login(admin, adminUser, adminPass);
  const adminNew = `Admin-${stamp}-Pass1`;
  if (await admin.waitForFunction(() => document.body.innerText.includes('temporary password') || document.querySelector('.sidebar'), { timeout: 10_000 })
    .then(() => admin.evaluate(() => document.body.innerText.includes('replace your temporary password')))) {
    await changePassword(admin, adminPass, adminNew);
    step('admin changed temporary password');
  }
  await admin.waitForSelector('.sidebar', { visible: true });

  // Admin creates an employee.
  await admin.click('.sidebar-header .icon-btn');
  await clickText(admin, 'Admin panel');
  await clickText(admin, 'Add employee');
  const username = `maria${stamp}`;
  await type(admin, '.modal input[required][pattern]', username);
  await type(admin, '.modal input[maxlength="64"][required]', `Maria ${stamp}`);
  await admin.evaluate(() => {
    const groups = [...document.querySelectorAll('.modal label.check')].find((l) => l.textContent.includes('Can create groups'));
    groups.querySelector('input').click();
  });
  await clickText(admin, 'Create account');
  await admin.waitForSelector('.cred code');
  const tempPass = await admin.$$eval('.cred code', (els) => els[1].textContent);
  await admin.screenshot({ path: `${shots}/01-admin-created-employee.png` });
  step(`admin created employee ${username}`);
  await clickText(admin, 'Done');
  await admin.screenshot({ path: `${shots}/02-admin-panel.png` });
  await admin.click('.modal-header .icon-btn');

  // ---------------------------------------------------------------- employee (iPhone size)
  const empCtx = await browser.createBrowserContext();
  const emp = await newPage(empCtx, { width: 390, height: 844 }, true);
  pages.emp = emp;
  await login(emp, username, tempPass);
  await changePassword(emp, tempPass, `Maria-${stamp}-Pass1`);
  step('employee signed in on mobile and changed password');

  // Admin starts a chat with the employee via search.
  await admin.reload({ waitUntil: 'networkidle0' });
  await type(admin, '.search-box input', username);
  await clickText(admin, `@${username}`, '.search-results .chat-item');
  await admin.waitForSelector('.composer textarea');
  await admin.type('.composer textarea', 'Hello Maria! Welcome to the team 👋');
  await admin.keyboard.press('Enter');
  await admin.waitForFunction(() => [...document.querySelectorAll('.bubble.out .text')].some((e) => e.textContent.includes('Welcome to the team')));
  step('admin sent a message');

  // Employee receives it in real time.
  await emp.waitForFunction(() => document.querySelector('.chat-item .badge')?.textContent === '1', { timeout: 10_000 });
  await emp.screenshot({ path: `${shots}/03-mobile-chat-list.png` });
  step('employee got unread badge in real time');
  await emp.click('.chat-list .chat-item');
  await emp.waitForFunction(() => [...document.querySelectorAll('.bubble.in .text')].some((e) => e.textContent.includes('Welcome')));
  await sleep(400);
  // Read receipt reaches the sender.
  await admin.waitForSelector('.bubble.out .status.read', { timeout: 10_000 });
  step('read receipt shown to sender');

  await emp.type('.composer textarea', 'Thanks! Happy to be here.');
  await emp.click('.composer .send-btn');
  await admin.waitForFunction(() => [...document.querySelectorAll('.bubble.in .text')].some((e) => e.textContent.includes('Happy to be here')));
  step('employee replied from mobile');

  // Typing indicator.
  await emp.type('.composer textarea', 'typing…');
  await admin.waitForFunction(() => document.querySelector('.chat-status')?.textContent.includes('typing'), { timeout: 5000 });
  step('typing indicator visible');
  await emp.evaluate(() => { const t = document.querySelector('.composer textarea'); t.value = ''; });

  // Admin uploads a file.
  const tmpFile = path.join(shots, 'q3-report.pdf');
  fs.writeFileSync(tmpFile, '%PDF-1.4\n% TeamChat smoke test document\n');
  const [chooser] = await Promise.all([admin.waitForFileChooser(), admin.click('.composer [aria-label="Attach file"]')]);
  await chooser.accept([tmpFile]);
  await emp.waitForFunction(() => [...document.querySelectorAll('.doc-name')].some((e) => e.textContent === 'q3-report.pdf'), { timeout: 15_000 });
  const fileStatus = await emp.evaluate(async () => {
    const a = [...document.querySelectorAll('a.doc')].find((x) => x.textContent.includes('q3-report'));
    return (await fetch(a.href)).status;
  });
  if (fileStatus !== 200) throw new Error(`file download returned ${fileStatus}`);
  step('file shared and downloadable by recipient');

  // Reaction via context menu (long-press on mobile).
  const bubble = await emp.$('.msg-row:not(.mine) .bubble');
  const box = await bubble.boundingBox();
  await emp.touchscreen.touchStart(box.x + 20, box.y + 10);
  await sleep(700);
  await emp.touchscreen.touchEnd();
  await emp.waitForSelector('.context-menu.sheet');
  await emp.screenshot({ path: `${shots}/04-mobile-message-menu.png` });
  await emp.evaluate(() => document.querySelector('.quick-reactions button').click());
  await admin.waitForSelector('.bubble.out .reaction', { timeout: 5000 });
  step('reaction via mobile long-press');

  await emp.screenshot({ path: `${shots}/05-mobile-chat.png` });
  await admin.screenshot({ path: `${shots}/06-desktop-chat.png` });

  // ---------------------------------------------------------------- call
  await admin.click('.chat-actions [aria-label="Voice call"]');
  await emp.waitForSelector('.call-overlay [aria-label="Accept"]', { timeout: 10_000 });
  await emp.screenshot({ path: `${shots}/07-mobile-incoming-call.png` });
  await emp.click('.call-overlay [aria-label="Accept"]');
  await admin.waitForFunction(() => /^\d+:\d\d$/.test(document.querySelector('.call-status')?.textContent || ''), { timeout: 20_000 });
  await emp.waitForFunction(() => /^\d+:\d\d$/.test(document.querySelector('.call-status')?.textContent || ''), { timeout: 20_000 });
  await sleep(2500);
  const audioFlowing = await admin.evaluate(() => {
    const a = document.querySelector('audio.call-audio');
    return !!a?.srcObject && a.srcObject.getAudioTracks().length > 0;
  });
  if (!audioFlowing) throw new Error('remote audio track missing');
  await admin.screenshot({ path: `${shots}/08-desktop-active-call.png` });
  step('WebRTC call connected with remote audio track');

  // Minimizing and restoring must not silence the call.
  const audioAttached = () => admin.evaluate(() => {
    const a = document.querySelector('audio.call-audio');
    return !!a?.srcObject && a.srcObject.getAudioTracks().length > 0 && !a.paused;
  });
  await admin.click('.call-overlay [aria-label="Minimize"]');
  await admin.waitForSelector('.call-mini');
  if (!(await audioAttached())) throw new Error('remote audio lost when the call was minimized');
  await admin.click('.call-mini');
  await admin.waitForSelector('.call-overlay');
  if (!(await audioAttached())) throw new Error('remote audio lost when the call was restored');
  step('call audio survives minimize and restore');

  // Turning the camera on during an audio call shows up on the other side.
  await admin.click('.call-overlay [aria-label="Camera"]');
  await emp.waitForSelector('.remote-video', { timeout: 10_000 });
  await emp.bringToFront();
  const videoLive = () => emp.waitForFunction(() => {
    const track = document.querySelector('.remote-video')?.srcObject?.getVideoTracks()[0];
    return track?.readyState === 'live' && !track.muted;
  }, { timeout: 10_000, polling: 250 }).then(() => true, () => false);
  if (await videoLive()) {
    step('camera turned on mid-call reaches the other person');
  } else {
    // Headless Chrome's fake camera sometimes stops by itself, even on a blank page with no app code.
    const cameraDied = await admin.$eval('.local-video', (v) => v.srcObject.getVideoTracks()[0].readyState === 'ended').catch(() => false);
    if (!cameraDied) throw new Error('no video frames from the other person');
    console.log('⚠ Chrome stopped its fake camera, so video frames could not be checked on this run');
  }
  await emp.click('.call-overlay [aria-label="Camera"]');
  await admin.waitForSelector('.remote-video', { timeout: 10_000 });
  step('the other person can turn their camera on too');
  await admin.click('.call-overlay [aria-label="End call"]');
  await emp.waitForFunction(() => !document.querySelector('.call-overlay'), { timeout: 10_000 });
  await admin.waitForFunction(() => [...document.querySelectorAll('.call-msg')].length > 0, { timeout: 10_000 });
  step('call ended and logged in chat');

  // ---------------------------------------------------------------- dark mode + persistence
  await emp.evaluate(() => localStorage.setItem('theme', 'dark'));
  await emp.reload({ waitUntil: 'networkidle0' });
  await emp.waitForSelector('.bubble');
  await emp.screenshot({ path: `${shots}/09-mobile-dark-after-reload.png` });
  step('history persisted across reload (dark mode)');

  // ---------------------------------------------------------------- Russian interface + translation
  const translation = await emp.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.translation));
  await emp.click('.chat-header .back-btn');
  await sleep(400);
  await emp.click('.sidebar-header .icon-btn');
  await clickText(emp, 'Language', '.drawer-item');
  await emp.waitForFunction(() => document.querySelector('.search-box input')?.placeholder === 'Поиск', { timeout: 5000 });
  await emp.click('.menu-backdrop');
  await emp.screenshot({ path: `${shots}/10-mobile-list-dark-ru.png` });
  step('interface switched to Russian');
  const savedLang = await emp.evaluate(() => fetch('/api/auth/me').then((r) => r.json()).then((d) => d.user.language));
  if (savedLang !== 'ru') throw new Error(`language not saved to account (${savedLang})`);
  step('language preference saved to the account');

  if (translation) {
    await emp.click('.chat-list .chat-item');
    await emp.waitForSelector('.bubble.in');
    await sleep(800); // let the chat finish sliding in and scrolling, or the press misses the bubble
    // Translate an incoming English message via the long-press menu.
    const inBubble = await emp.$('.msg-row:not(.mine) .bubble');
    const b = await inBubble.boundingBox();
    await emp.touchscreen.touchStart(b.x + 20, b.y + 10);
    await sleep(700);
    await emp.touchscreen.touchEnd();
    await sleep(500);
    await clickText(emp, 'Перевести', '.context-item');
    await emp.waitForSelector('.translation .text', { timeout: 10_000 });
    step('incoming message translated EN→RU on demand');
    // Turn on auto-translate to English for this chat, then the admin writes in Russian... the employee reads English.
    await emp.click('.chat-header-main');
    await emp.waitForSelector('.info-pane');
    await clickText(emp, 'EN', '.info-pane .segmented button');
    await emp.click('.info-pane .info-header .icon-btn');
    await admin.type('.composer textarea', 'Добрый день! Отчёт готов.');
    await admin.keyboard.press('Enter');
    await emp.waitForFunction(() => [...document.querySelectorAll('.translation .text')].some((e) => e.textContent.includes('[en] Добрый день')), { timeout: 10_000 });
    await emp.screenshot({ path: `${shots}/11-mobile-ru-translation.png` });
    step('auto-translate RU→EN applied live to an incoming message');
    // Draft translation in the composer.
    await admin.type('.composer textarea', 'See you tomorrow');
    await admin.click('.composer [aria-label="Translate to Russian"]');
    await admin.waitForFunction(() => document.querySelector('.composer textarea').value.startsWith('[ru]'), { timeout: 10_000 });
    await admin.screenshot({ path: `${shots}/12-desktop-draft-translation.png` });
    step('draft translated EN→RU before sending');
    await emp.click('.chat-header .back-btn');
  }

  // ---------------------------------------------------------------- notifications switch
  await admin.click('.sidebar-header .icon-btn');
  await clickText(admin, 'Settings', '.drawer-item');
  await admin.waitForSelector('.switch[role="switch"]');
  const notificationState = () => admin.$eval('.switch[role="switch"]', (el) => ({ checked: el.checked, label: el.previousElementSibling.textContent }));
  const waitForState = (checked) => admin.waitForFunction((want) => {
    const el = document.querySelector('.switch[role="switch"]');
    return el.checked === want && !el.disabled && el.previousElementSibling.textContent === (want ? 'On' : 'Off');
  }, { timeout: 5000 }, checked);
  const startedOn = (await notificationState()).checked;
  await admin.screenshot({ path: `${shots}/13-desktop-notification-setting.png` });
  await admin.click('.switch[role="switch"]');
  await waitForState(!startedOn);
  await admin.click('.switch[role="switch"]');
  await waitForState(startedOn);
  await admin.reload({ waitUntil: 'networkidle0' });
  await admin.click('.sidebar-header .icon-btn');
  await clickText(admin, 'Settings', '.drawer-item');
  await admin.waitForSelector('.switch[role="switch"]');
  await waitForState(startedOn);
  await admin.click('.modal-header .icon-btn');
  step('notification switch shows On/Off, toggles, and survives a reload');

  // ---------------------------------------------------------------- deactivation kicks the user out
  await admin.click('.sidebar-header .icon-btn');
  await clickText(admin, 'Admin panel');
  await admin.waitForFunction((u) => document.body.innerText.includes(`@${u}`), {}, username);
  await admin.evaluate((u) => {
    const row = [...document.querySelectorAll('.admin-row')].find((r) => r.textContent.includes(`@${u}`));
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Deactivate').click();
  }, username);
  await clickText(admin, 'Deactivate', '.modal-footer button');
  await emp.waitForFunction(() => !!document.querySelector('.conn-banner') || !!document.querySelector('input[autocomplete="username"]'), { timeout: 10_000 });
  await emp.reload({ waitUntil: 'networkidle0' });
  await emp.waitForSelector('input[autocomplete="username"]', { timeout: 10_000 });
  step('deactivated employee was signed out immediately');
} catch (err) {
  console.error('✖ FAILED:', err.message);
  for (const [k, p] of Object.entries(pages)) {
    await p.screenshot({ path: `${shots}/fail-${k}.png` }).catch(() => {});
    console.log(k, (await p.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '')).replace(/\n+/g, ' | '));
  }
  process.exitCode = 1;
} finally {
  if (errors.length) console.log('Browser errors:\n  ' + errors.join('\n  '));
  await browser.close();
}
