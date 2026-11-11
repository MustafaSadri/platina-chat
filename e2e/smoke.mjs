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
  await admin.waitForSelector('.media-preview .media-send');
  await admin.click('.media-preview .media-send');
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
  let fakeCameraDied = false;
  if (await videoLive()) {
    step('camera turned on mid-call reaches the other person');
  } else {
    // Headless Chrome's fake camera sometimes stops by itself, even on a blank page with no app code.
    const cameraDied = await admin.$eval('.local-video', (v) => v.srcObject.getVideoTracks()[0].readyState === 'ended').catch(() => false);
    if (!cameraDied) throw new Error('no video frames from the other person');
    console.log('⚠ Chrome stopped its fake camera, so video frames could not be checked on this run');
    fakeCameraDied = true;
  }
  if (!fakeCameraDied) {
    await emp.click('.call-overlay [aria-label="Camera"]');
    await admin.waitForSelector('.remote-video', { timeout: 10_000 });
    step('the other person can turn their camera on too');
  }
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

  // ---------------------------------------------------------------- groups: message actions
  const callApi = (page, method, url, body) => page.evaluate(async (m, u, b) => {
    const r = await fetch(`/api${u}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return r.json();
  }, method, url, body);
  const empUser = (await callApi(admin, 'GET', `/users?q=${username}`)).users[0];
  const thirdName = `sam${stamp}`;
  const thirdMade = await callApi(admin, 'POST', '/admin/users', { username: thirdName, displayName: `Sam ${stamp}` });
  const thirdCtx = await browser.createBrowserContext();
  const third = await newPage(thirdCtx, { width: 900, height: 700 });
  pages.third = third;
  await login(third, thirdName, thirdMade.tempPassword);
  await changePassword(third, thirdMade.tempPassword, `Sam-${stamp}-Pass1`);
  const groupTitle = `Smoke group ${stamp}`;
  await callApi(admin, 'POST', '/chats/group', { title: groupTitle, memberIds: [empUser.id, thirdMade.user.id] });
  await callApi(admin, 'POST', '/chats/direct', { userId: thirdMade.user.id });
  await admin.reload({ waitUntil: 'networkidle0' });
  await clickText(admin, groupTitle, '.chat-item');
  await emp.waitForFunction((title) => document.body.innerText.includes(title), { timeout: 10_000 }, groupTitle);
  await clickText(emp, groupTitle, '.chat-item');
  await emp.waitForSelector('.composer textarea');
  await sleep(800);

  // Long-press with a finger that isn't perfectly still, as on a real phone.
  await emp.type('.composer textarea', 'edit this message');
  await emp.click('.composer .send-btn');
  await admin.waitForFunction(() => [...document.querySelectorAll('.bubble .text')].some((e) => e.textContent === 'edit this message'));
  await emp.waitForFunction(() => !!document.querySelector('.msg-row.mine:last-of-type .bubble .text') || [...document.querySelectorAll('.bubble.out .text')].some((e) => e.textContent === 'edit this message'));
  await sleep(500);
  const ownBubble = (await emp.$$('.bubble.out')).at(-1);
  const pressBox = await ownBubble.boundingBox();
  await emp.touchscreen.touchStart(pressBox.x + 30, pressBox.y + 12);
  await sleep(100);
  await emp.touchscreen.touchMove(pressBox.x + 33, pressBox.y + 14);
  await sleep(600);
  await emp.touchscreen.touchEnd();
  await emp.waitForSelector('.context-menu.sheet', { timeout: 5000 });
  await emp.screenshot({ path: `${shots}/14-mobile-message-menu.png` });
  step('long-press opens the message menu even when the finger moves slightly');
  await sleep(450);
  await emp.evaluate(() => [...document.querySelectorAll('.context-item')].find((b) => /Edit|Редакт|Измен/.test(b.textContent)).click());
  await emp.waitForFunction(() => document.querySelector('.composer textarea').value === 'edit this message');
  await emp.evaluate(() => { const el = document.querySelector('.composer textarea'); el.focus(); el.select(); });
  await emp.type('.composer textarea', 'edited in the group');
  await emp.click('.composer .send-btn');
  await admin.waitForFunction(() => [...document.querySelectorAll('.bubble')].some((b) => b.textContent.includes('edited in the group') && b.querySelector('.edited')), { timeout: 10_000 });
  step('edited message shows the new text and an "edited" label to other members');

  const sendFromAdmin = async (text) => {
    await admin.type('.composer textarea', text);
    await admin.keyboard.press('Enter');
    await admin.waitForFunction((x) => [...document.querySelectorAll('.bubble.out .text')].some((e) => e.textContent === x), {}, text);
    await emp.waitForFunction((x) => [...document.querySelectorAll('.bubble .text')].some((e) => e.textContent === x), {}, text);
  };
  const openDelete = async (text) => {
    const handle = await admin.evaluateHandle((x) => [...document.querySelectorAll('.bubble.out')].find((b) => b.querySelector('.text')?.textContent === x), text);
    await handle.click({ button: 'right' });
    await sleep(450); // the menu ignores taps just after opening
    await clickText(admin, 'Delete', '.context-item');
    await admin.waitForSelector('.delete-choices');
  };
  await sendFromAdmin('gone for everyone');
  await sleep(400);
  await openDelete('gone for everyone');
  await admin.screenshot({ path: `${shots}/15-desktop-delete-choices.png` });
  await clickText(admin, 'Delete for everyone', '.delete-choices button');
  await emp.waitForFunction(() => ![...document.querySelectorAll('.bubble .text')].some((e) => e.textContent === 'gone for everyone'), { timeout: 10_000 });
  step('delete for everyone removes the message for other members');
  await sendFromAdmin('gone only for me');
  await sleep(400);
  await openDelete('gone only for me');
  await clickText(admin, 'Delete for me', '.delete-choices button');
  await admin.waitForFunction(() => ![...document.querySelectorAll('.bubble .text')].some((e) => e.textContent === 'gone only for me'), { timeout: 10_000 });
  if (!(await emp.evaluate(() => [...document.querySelectorAll('.bubble .text')].some((e) => e.textContent === 'gone only for me')))) throw new Error('delete for me removed the message for others');
  step('delete for me keeps the message for other members');

  // Phones: a single tap on a message opens its menu, like Telegram.
  await emp.bringToFront();
  const tapTarget = (await emp.$$('.bubble.out')).at(-1);
  const tapBox = await tapTarget.boundingBox();
  await emp.touchscreen.tap(tapBox.x + 20, tapBox.y + 10);
  await emp.waitForSelector('.context-menu.sheet', { timeout: 5000 });
  await sleep(450);
  await emp.click('.menu-backdrop');
  await emp.waitForFunction(() => !document.querySelector('.context-menu'));
  step('tapping a message on a phone opens its menu');

  // @mentions: pick a member from the list while typing.
  await emp.type('.composer textarea', 'hi @adm');
  await emp.waitForSelector('.mention-option', { timeout: 5000 });
  await emp.screenshot({ path: `${shots}/22-mobile-mention-picker.png` });
  await emp.click('.mention-option');
  await emp.waitForFunction(() => document.querySelector('.composer textarea').value === 'hi @admin ');
  await emp.type('.composer textarea', 'please check the numbers');
  await emp.click('.composer .send-btn');
  await admin.waitForFunction(() => [...document.querySelectorAll('.bubble .text')].some((e) => e.textContent === 'hi @admin please check the numbers' && e.querySelector('.mention.me')?.textContent === '@admin'), { timeout: 10_000 });
  step('@mention picked from the list and highlighted for the tagged person');

  // Seen by: who read a group message, and when.
  await admin.type('.composer textarea', 'who has seen this');
  await admin.keyboard.press('Enter');
  await emp.waitForFunction(() => [...document.querySelectorAll('.bubble .text')].some((e) => e.textContent === 'who has seen this'));
  await emp.bringToFront();
  await emp.evaluate(() => { const el = document.querySelector('.messages'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await sleep(800);
  const seenHandle = await admin.evaluateHandle(() => [...document.querySelectorAll('.bubble.out')].find((b) => b.querySelector('.text')?.textContent === 'who has seen this'));
  await seenHandle.click({ button: 'right' });
  await sleep(450);
  await clickText(admin, 'Seen by', '.context-item');
  await admin.waitForFunction((name) => [...document.querySelectorAll('.modal .member-row')].some((r) => r.textContent.includes(name) && /\d/.test(r.textContent)), { timeout: 10_000 }, `Maria ${stamp}`);
  await admin.screenshot({ path: `${shots}/23-desktop-seen-by.png` });
  await admin.click('.modal-header .icon-btn');
  step('"Seen by" shows who read a group message and when');

  // A photo with a caption, whose first upload fails: Retry uploads it again.
  await admin.setRequestInterception(true);
  let failNextUpload = true;
  const interceptor = (req) => {
    if (failNextUpload && req.method() === 'POST' && /\/api\/chats\/\d+\/files$/.test(req.url())) {
      failNextUpload = false;
      req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal server error.' }) });
    } else req.continue();
  };
  admin.on('request', interceptor);
  const [photoChooser] = await Promise.all([admin.waitForFileChooser(), admin.click('.composer [aria-label="Attach file"]')]);
  await photoChooser.accept([`${shots}/01-admin-created-employee.png`]);
  await admin.waitForSelector('.media-preview .caption-input');
  await admin.type('.media-preview .caption-input', 'photo with a caption');
  await admin.screenshot({ path: `${shots}/24-desktop-caption-preview.png` });
  await admin.click('.media-preview .media-send');
  await admin.waitForSelector('.failed-actions', { timeout: 10_000 });
  step('a failed photo upload offers Retry');
  await clickText(admin, 'Retry', '.failed-actions button');
  await emp.waitForFunction(() => [...document.querySelectorAll('.bubble')].some((b) => b.querySelector('.media img') && b.textContent.includes('photo with a caption')), { timeout: 15_000 });
  await admin.waitForFunction(() => !document.querySelector('.failed-actions'));
  admin.off('request', interceptor);
  await admin.setRequestInterception(false);
  step('Retry uploads the photo again and it arrives with its caption');

  // The photo viewer's back button can't be covered by the picture.
  await emp.bringToFront();
  const photo = await emp.evaluateHandle(() => [...document.querySelectorAll('.bubble')].reverse().find((b) => b.textContent.includes('photo with a caption')).querySelector('.media'));
  await photo.click();
  await emp.waitForSelector('.viewer [aria-label="Back"]');
  const backReachable = await emp.$eval('.viewer [aria-label="Back"]', (b) => {
    const r = b.getBoundingClientRect();
    return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  if (!backReachable) throw new Error('the photo covers the viewer back button');
  await emp.waitForFunction(() => { const img = document.querySelector('.viewer-image'); return img?.complete && img.naturalWidth > 0; }, { timeout: 10_000 });
  const imgBox = await (await emp.$('.viewer-image')).boundingBox();
  await emp.touchscreen.tap(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
  await sleep(120);
  await emp.touchscreen.tap(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
  await emp.waitForFunction(() => /scale\(2\.5\)/.test(document.querySelector('.viewer-image').style.transform), { timeout: 3000 });
  await sleep(300);
  await emp.screenshot({ path: `${shots}/25-mobile-photo-viewer.png` });
  step('double-tap zooms the photo');
  if (!(await emp.$('.viewer [aria-label="Download"]'))) throw new Error('no save button in the photo viewer');
  await emp.click('.viewer [aria-label="Back"]');
  await emp.waitForFunction(() => !document.querySelector('.viewer'));
  await emp.waitForSelector('.composer textarea');
  step('photo viewer has a reachable Back button and closes back to the chat');

  // ---------------------------------------------------------------- profile
  await admin.click('.sidebar-header .icon-btn');
  await clickText(admin, 'Settings', '.drawer-item');
  await admin.waitForSelector('.avatar-picker input');
  await (await admin.$('.avatar-picker input')).uploadFile(`${shots}/02-admin-panel.png`);
  await admin.waitForSelector('.settings-me .avatar-photo', { timeout: 10_000 });
  await admin.click('.name-edit');
  await admin.waitForSelector('.name-form input');
  await admin.evaluate(() => { const el = document.querySelector('.name-form input'); el.focus(); el.select(); });
  await admin.type('.name-form input', 'Pikachu');
  await admin.keyboard.press('Enter');
  await admin.waitForFunction(() => document.querySelector('.settings-me .info-title')?.textContent === 'Pikachu', { timeout: 5000 });
  await admin.screenshot({ path: `${shots}/16-desktop-profile.png` });
  await admin.click('.modal-header .icon-btn');
  await emp.waitForFunction(() => document.body.innerText.includes('Pikachu') && !!document.querySelector('.avatar-photo'), { timeout: 10_000 });
  await third.waitForFunction(() => document.body.innerText.includes('Pikachu'), { timeout: 10_000 });
  await emp.screenshot({ path: `${shots}/17-mobile-new-name-and-photo.png` });
  step('new display name and photo reach everyone live');

  // ---------------------------------------------------------------- group call, three people
  await admin.click('.chat-actions [aria-label="Group voice call"]');
  await admin.waitForSelector('.group-call', { timeout: 10_000 });
  await emp.waitForSelector('.group-ringing [aria-label="Accept"]', { timeout: 10_000 });
  await third.waitForSelector('.group-ringing [aria-label="Accept"]', { timeout: 10_000 });
  await emp.screenshot({ path: `${shots}/18-mobile-group-call-ringing.png` });
  step('group members are rung');
  await emp.click('.group-ringing [aria-label="Accept"]');
  await third.click('.group-ringing [aria-label="Accept"]');
  const fullyConnected = (page) => page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('audio.call-audio')];
    return document.querySelectorAll('.group-tile').length === 3 && !document.querySelector('.group-tile-name')?.parentElement.parentElement.textContent.includes('· …')
      && audio.length === 2 && audio.every((a) => a.srcObject?.getAudioTracks().length > 0 && !a.paused);
  }, { timeout: 30_000, polling: 300 });
  await Promise.all([fullyConnected(admin), fullyConnected(emp), fullyConnected(third)]);
  await admin.screenshot({ path: `${shots}/19-desktop-group-call.png` });
  await emp.screenshot({ path: `${shots}/20-mobile-group-call.png` });
  step('three people connected, each receiving audio from the other two');
  await admin.click('.group-call [aria-label="Minimize"]');
  await admin.waitForSelector('.call-mini');
  if ((await admin.$$eval('audio.call-audio', (els) => els.filter((a) => a.srcObject && !a.paused).length)) !== 2) throw new Error('audio lost when the group call was minimized');
  await admin.click('.call-mini');
  await admin.waitForSelector('.group-call');
  step('group call audio survives minimize');
  await admin.click('.group-call [aria-label="Camera"]');
  const groupVideo = await emp.waitForFunction(() => {
    const track = document.querySelector('.group-video')?.srcObject?.getVideoTracks()[0];
    return track?.readyState === 'live' && !track.muted;
  }, { timeout: 12_000, polling: 250 }).then(() => true, () => false);
  if (groupVideo) {
    await emp.screenshot({ path: `${shots}/21-mobile-group-video.png` });
    step('camera turned on in a group call reaches the others');
  } else {
    // Once Chrome's fake camera has died in this run, no page can start a camera again.
    const died = fakeCameraDied || await admin.$eval('.group-video', (v) => v.srcObject.getVideoTracks()[0].readyState === 'ended').catch(() => false);
    if (!died) throw new Error('no group video from the other person');
    console.log('⚠ Chrome stopped its fake camera, so group video frames could not be checked on this run');
  }
  await third.click('.group-call [aria-label="End call"]');
  await emp.waitForFunction(() => document.querySelectorAll('.group-tile').length === 2, { timeout: 10_000 });
  step('someone leaving keeps the call going for the rest');
  await emp.click('.group-call [aria-label="End call"]');
  await admin.click('.group-call [aria-label="End call"]');
  await third.waitForFunction(() => !document.querySelector('.group-call-bar'), { timeout: 10_000 });
  await admin.waitForFunction(() => [...document.querySelectorAll('.call-msg')].some((e) => e.textContent.includes('Group call')), { timeout: 10_000 });
  step('group call ended and logged in the chat');

  // ---------------------------------------------------------------- deleting a removed person
  await callApi(admin, 'DELETE', `/admin/users/${thirdMade.user.id}`);
  await sleep(500);
  const removedName = `Sam ${stamp}`;
  await admin.reload({ waitUntil: 'networkidle0' });
  const removedItem = await admin.evaluateHandle((n) => [...document.querySelectorAll('.chat-list .chat-item')].find((b) => b.querySelector('.chat-item-title')?.textContent.trim() === n), removedName);
  await removedItem.click({ button: 'right' });
  await sleep(450);
  await clickText(admin, 'Delete user for me', '.context-item');
  await clickText(admin, 'Delete', '.modal-footer button');
  await admin.waitForFunction((n) => ![...document.querySelectorAll('.chat-list .chat-item')].some((b) => b.querySelector('.chat-item-title')?.textContent.trim() === n), { timeout: 5000 }, removedName);
  await admin.reload({ waitUntil: 'networkidle0' });
  if (await admin.evaluate((n) => [...document.querySelectorAll('.chat-list .chat-item')].some((b) => b.querySelector('.chat-item-title')?.textContent.trim() === n), removedName)) throw new Error('deleted chat came back after reload');
  step('a removed person can be deleted from the chat list');

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
