import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { remote, Key } from 'webdriverio';

if (process.platform !== 'darwin') throw new Error('Desktop E2E requires macOS 14+');
const live = process.argv.includes('--live');
const root = resolve('artifacts/e2e');
await mkdir(root, { recursive: true });
const run = await mkdtemp(join(root, live ? 'live-' : 'desktop-'));
const results = [];
const requests = [];
const frontendLogs = [];
let mode = 'matches';
let app, browser;
let starts = 0;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const wait = async (check, message, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(message);
};
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push({ method: req.method, path: req.url, headers: req.headers, body, mode });
  const responseMode = mode;
  const reply = () => {
    if (res.destroyed) return;
    res.writeHead(responseMode === 'error' ? 429 : 200, { 'content-type': 'application/json' });
    const answers = Object.fromEntries(Object.entries(body.state.passages).map(([id, text]) =>
      [id, { type: 'noul', noul: responseMode === 'none' ? 0.1 : text.includes('nascose la scatola') ? 0.96 : id === 'p0002' ? 0.55 : id === 'p0003' ? 0.49 : 0.1 }]));
    res.end(JSON.stringify({ answers }));
  };
  if (mode === 'slow') setTimeout(reply, 1500); else reply();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const portServer = createServer();
await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const driverPort = portServer.address().port;
await new Promise(r => portServer.close(r));
const config = {
  identifier: 'org.nanto.liauth.e2e',
  app: { withGlobalTauri: true, windows: [{ label: 'main', title: 'Liauth E2E', width: 1100, height: 760, visible: false, focus: false, focusable: false }] },
};
await writeFile(join(run, 'tauri.json'), JSON.stringify(config));
const repo = join(run, 'novel');
await mkdir(repo);
const chapter = join(repo, 'chapter.md');
const paragraphs = Array.from({length: 20}, (_, i) => `Appunto ${i}. La biblioteca chiude alle diciotto. I libri vanno riposti sugli scaffali indicati.`);
paragraphs[18] = '😀 Quando rimase solo, Carlo nascose la scatola sotto il pavimento. Rimise il tappeto prima che gli altri tornassero.';
const source = paragraphs.join('\n\n');
await writeFile(chapter, source);
await writeFile(join(repo, 'second.md'), '# Secondo capitolo\n\nLa biblioteca era silenziosa.\n');
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.email', 'e2e@example.invalid');
git(repo, 'config', 'user.name', 'Liauth E2E');
git(repo, 'add', 'chapter.md', 'second.md');
git(repo, 'commit', '-m', 'Initial synthetic manuscript');
const env = { ...process.env, TAURI_WEBDRIVER_PORT: String(driverPort), LIAUTH_E2E_CONFIG: join(run, 'config'), LIAUTH_E2E_DATA_STORE: JSON.stringify([...randomBytes(16)]) };
delete env.TYPESAFE_API_KEY;
delete env.LIAUTH_E2E_JEV_ENDPOINT;
if (!live) env.LIAUTH_E2E_JEV_ENDPOINT = `http://127.0.0.1:${server.address().port}/v1/systemone`;
const assertBackground = async () => {
  assert.deepEqual(await browser.execute(async () => {
    const appWindow = globalThis.__TAURI__.window.getCurrentWindow();
    return { visible: await appWindow.isVisible(), focused: await appWindow.isFocused() };
  }), { visible: false, focused: false }, 'E2E must stay off the desktop');
};
const start = async () => {
  app = spawn(resolve('src-tauri/target/debug/liauth'), [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(run, 'app.log'), { flags: 'a' });
  app.stdout.pipe(log, { end: false }); app.stderr.pipe(log, { end: false });
  app.once('close', () => log.end());
  await wait(async () => {
    if (app.exitCode !== null) throw new Error(`App exited: ${app.exitCode}`);
    try { return (await fetch(`http://127.0.0.1:${driverPort}/status`)).ok; } catch { return false; }
  }, 'WebDriver did not start', 30000);
  browser = await remote({ hostname: '127.0.0.1', port: driverPort, capabilities: { browserName: 'wry' }, logLevel: 'error', connectionRetryCount: 0 });
  await browser.$('.cm-content').waitForExist();
  await assertBackground();
  const previousRun = await browser.execute(run => {
    const previous = localStorage.getItem('liauth.e2eRun');
    localStorage.setItem('liauth.e2eRun', run);
    return previous;
  }, run);
  assert.equal(previousRun, starts++ === 0 ? null : run, 'WebView storage must be isolated between runs and persistent across restarts');
  await browser.execute(() => {
    window.__e2eLog = [];
    for (const level of ['warn', 'error']) {
      const original = console[level];
      console[level] = (...args) => { window.__e2eLog.push({ level, text: args.map(String).join(' ') }); original.apply(console, args); };
    }
    window.addEventListener('error', event => window.__e2eLog.push({ level: 'error', text: event.message }));
  });
};
const stop = async () => {
  if (browser) {
    frontendLogs.push(...await browser.execute(() => window.__e2eLog ?? []).catch(() => []));
    await browser.deleteSession().catch(() => {}); browser = null;
  }
  if (app && app.exitCode === null) {
    const exited = new Promise(r => app.once('exit', r));
    app.kill('SIGTERM');
    const deadline = setTimeout(() => app.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(deadline);
  }
};
const bodyText = () => browser.$('body').getText();
const clickText = async text => {
  const el = await browser.$(`button=${text}`);
  await el.waitForExist(); await el.click();
};
const command = async title => {
  await browser.keys([Key.Command, 'k']);
  const input = await browser.$('.palette-input');
  await input.waitForExist();
  await input.setValue(title);
  const item = await browser.$('.palette-list').$(`li*=${title}`);
  await item.waitForExist();
  await item.click();
  await browser.$('.palette-input').waitForExist({ reverse: true });
};
const open = async path => {
  await browser.execute(async path => window.__TAURI__.event.emit('open-file', path), path);
  await wait(async () => (await browser.execute(() => localStorage.getItem('liauth.lastFile'))) === path, `Did not open ${path}`);
  await browser.$('button=History').waitForExist();
};
const text = () => browser.execute(() => [...document.querySelectorAll('.cm-content .cm-line')].map(line => line.textContent).join('\n'));
const edit = async value => {
  await browser.$('.cm-content').click();
  await browser.keys([Key.Command, 'a']);
  const handled = await browser.execute(value => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    return !document.querySelector('.cm-content').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, value);
  assert.equal(handled, true, 'The editor did not handle pasted text');
};
const query = async value => {
  await browser.$('.semantic-query').setValue(value);
  await clickText('Find with Jev');
};
const snapshot = async name => {
  await assertBackground();
  await browser.saveScreenshot(join(run, `${name}.png`));
  await writeFile(join(run, `${name}.html`), await browser.getPageSource());
};
const scenario = async (name, fn) => {
  const started = Date.now();
  try {
    await fn(); await snapshot(name);
    results.push({ name, status: 'passed', durationMs: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack });
    await snapshot(`${name}-failure`).catch(() => {});
    throw error;
  }
};
try {
  const build = spawn('npm', ['run', 'tauri', '--', 'build', '--debug', '--no-bundle', '--features', 'e2e', '--config', join(run, 'tauri.json')], { stdio: 'inherit' });
  if (await new Promise(r => build.on('exit', r)) !== 0) throw new Error('E2E build failed');
  
  await start();
  await open(chapter);
  await scenario('jev-batches-and-selection', async () => {
    await edit(source.replace('Quando rimase', 'Ancora non salvato. Quando rimase'));
    await snapshot('jev-unsaved-input');

    assert.equal(await readFile(chapter, 'utf8'), source);
    await command('Markdown Preview');
    await command('Find by Meaning');
    assert.equal(await browser.$('input[type="password"]').isExisting(), false);
    await query('Una persona occulta qualcosa perché gli altri non lo trovino');
    await browser.$('.semantic-results button').waitForExist({ timeout: 120000 });
    const match = await browser.$('.semantic-results button').getText();
    assert.match(match, /Carlo nascose la scatola/);
    await browser.$('.semantic-results button').click();
    await browser.execute(() => document.querySelector('.cm-content').focus());
    await wait(async () => (await browser.execute(() => window.getSelection().toString())).includes('Carlo nascose la scatola'), 'Result did not select the source passage');
    assert.equal(await browser.$('.proof-hidden').isExisting(), false);
    if (!live) {
      assert.ok(requests.some(r => JSON.stringify(r.body.state.passages).includes('Ancora non salvato')));
      assert.equal((await browser.$$('.semantic-results button')).length, 2);
      assert.match(await browser.$('.semantic-results').getText(), /Possible match/);
      assert.equal(requests.length, 2);
      assert.equal(requests.reduce((n, r) => n + Object.keys(r.body.questions).length, 0), 20);
      for (const r of requests) {
        assert.equal(r.method, 'POST'); assert.equal(r.path, '/v1/systemone'); assert.equal(r.body.model, 'jev');
        assert.equal(r.headers.authorization, undefined);
      }
    }
  });
  if (!live) {
    await scenario('jev-errors-cancel-and-stale-results', async () => {
      await edit('Risultati invalidati da questa modifica.');
      await wait(async () => !(await browser.$('.semantic-results button').isExisting()), 'Displayed results survived an edit');
      assert.match(await bodyText(), /Document changed/);
      mode = 'error'; await query('error');
      await browser.$('[role="alert"]').waitForExist();
      assert.match(await browser.$('[role="alert"]').getText(), /busy|rate limited/);
      assert.doesNotMatch(await bodyText(), /No convincing matches/);
      mode = 'none'; await query('none');
      await wait(async () => (await bodyText()).includes('No convincing matches'), 'No-match state missing');
      assert.equal(await browser.$('[role="alert"]').isExisting(), false);
      mode = 'slow';
      for (const action of ['cancel', 'edit', 'query', 'switch']) {
        await open(chapter);
        await edit(source);
        const before = requests.length;
        await query(`stale after ${action}`);
        await wait(() => requests.length > before, 'Request never reached HTTP server');
        if (action === 'cancel') await clickText('Cancel');
        if (action === 'edit') await edit('Documento cambiato durante la ricerca.');
        if (action === 'query') await browser.$('.semantic-query').setValue('Nuova ricerca');
        if (action === 'switch') await open(join(repo, 'second.md'));
        await new Promise(r => setTimeout(r, 1800));
        assert.equal(requests.length, before + 1, `Unexpected additional batch after ${action}`);
        assert.equal(await browser.$('.semantic-results button').isExisting(), false, `Stale results after ${action}`);
      }
      await open(chapter);
      mode = 'matches';
    });
  }
  await scenario('autosave-restart-and-history', async () => {
    await edit('Prima riga.\n\nTesto salvato automaticamente 😀.\n\nUltima riga.');
    await browser.execute(() => window.dispatchEvent(new Event('blur')));
    await wait(async () => (await readFile(chapter, 'utf8')).includes('automaticamente'), 'Autosave did not reach disk');
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '1');
    await command('Save (Commit)');
    await wait(() => git(repo, 'rev-list', '--count', 'HEAD') === '2', 'Save did not commit');
    await stop(); await start();
    await wait(async () => (await text()).includes('automaticamente'), 'Restart lost document');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    await clickText('History');
    assert.equal((await browser.$$('.commit-list li')).length, 2);
  });
  await scenario('native-italian-spelling-and-persistence', async () => {
    const spellingFile = join(repo, 'spelling.md');
    const typo = 'cosìgranitico';
    const prose = `😀 È **${typo}**, perché è rigido.\n\n\`${typo}\` [sito](https://${typo}.example)\n\n{>>${typo}<<}\n\n{==${typo}==}{>>nota<<}`;
    await writeFile(spellingFile, prose);
    await open(spellingFile);
    // Read the installed dictionary's localized name, then choose it through the UI.
    const languages = await browser.execute(async () => window.__TAURI__.core.invoke('spelling_languages'));
    const italian = languages.find(l => l.code === 'it' || l.code.startsWith('it_'));
    assert.ok(italian, 'The macOS Italian dictionary must be installed');
    await command(`Spelling language: ${italian.name}`);
    await wait(async () => (await browser.$$('.cm-spelling-error')).length >= 2, 'Italian spelling marks missing');
    const marks = await browser.$$('.cm-spelling-error').map(el => el.getText());
    assert.equal(marks.filter(word => word === typo).length, 2);
    await browser.$('.cm-content').click();
    assert.equal((await browser.$$('.cm-spelling-error').map(el => el.getText())).filter(word => word === typo).length, 2);
    await command('Disable Spell Checking');
    assert.equal((await browser.$$('.cm-spelling-error')).length, 0);
    await command('Enable Spell Checking');
    await wait(async () => (await browser.$$('.cm-spelling-error')).length >= 2, 'Marks missing after toggle');
    assert.equal(await readFile(spellingFile, 'utf8'), prose);
    await stop(); await start();
    await wait(async () => (await browser.$$('.cm-spelling-error')).length >= 2, 'Marks missing after restart');
    assert.equal(await browser.execute(() => localStorage.getItem('liauth.spellLanguage')), italian.code);
    assert.equal(await readFile(spellingFile, 'utf8'), prose);
  });
  await scenario('branches-save-merge-and-history', async () => {
    await open(chapter);
    await clickText('Branches');
    // WebKit blocks script completion while prompt() is open. Answer it over
    // the independent WebDriver alert endpoint before awaiting the click.
    const clicking = clickText('New branch…');
    clicking.catch(() => {});
    await browser.waitUntil(async () => {
      try { return (await browser.getAlertText()) === 'Branch name'; } catch { return false; }
    }, { timeout: 10000 });
    await browser.sendAlertText('e2e-review'); await browser.acceptAlert();
    await clicking;
    await wait(() => git(repo, 'branch', '--show-current') === 'e2e-review', 'Branch creation failed');
    await edit('Prima riga rivista.\n\nTesto salvato automaticamente 😀.\n\nUltima riga.');
    await command('Save (Commit)');
    await wait(() => git(repo, 'rev-list', '--count', 'HEAD') === '3', 'Review not committed');
    await browser.$('.branch-list').$('li*=main').$('button=Switch').click();
    await wait(() => git(repo, 'branch', '--show-current') === 'main', 'Switch failed');
    assert.doesNotMatch(await text(), /Prima riga rivista/);
    await browser.$('.branch-list').$('li*=e2e-review').$('button=Merge in').click();
    await wait(async () => (await text()).includes('Prima riga rivista'), 'Merge did not update editor');
    assert.match(git(repo, 'show', 'HEAD:chapter.md'), /Prima riga rivista/);
    await clickText('History');
    assert.ok((await browser.$$('.commit-list li')).length >= 3);
  });
  await scenario('workspace-search-preview-and-undo', async () => {
    await clickText('Search');
    await clickText('Text');
    const input = await browser.$('input[aria-label="Search workspace contents"]');
    await input.setValue('silenziosa');
    await browser.$('.nav-search-file').waitForExist();
    await browser.$('.nav-search-file').click();
    await browser.$('.nav-search-result').click();
    await wait(async () => (await text()).includes('Secondo capitolo'), 'Search opened wrong file');
    await browser.execute(() => document.querySelector('.cm-content').focus());
    assert.equal(await browser.execute(() => window.getSelection().toString()), 'silenziosa');
    await edit('# Secondo capitolo\n\nLa biblioteca era molto silenziosa.');
    await command('Markdown Preview');
    await browser.$('.markdown-preview-screen').waitForExist();
    assert.match(await browser.$('.markdown-preview-screen').getText(), /molto silenziosa/);
    await command('Exit Markdown Preview');
    await browser.$('.cm-content').click();
    await browser.keys([Key.Command, 'z']);
    await wait(async () => !(await text()).includes('molto'), 'Preview lost Undo history');
    await open(chapter);
  });
  await scenario('external-change-three-way-merge', async () => {
    const original = await readFile(chapter, 'utf8');
    await edit(original.replace('Prima riga rivista.', 'Prima riga locale.'));
    await writeFile(chapter, original.replace('Ultima riga.', 'Ultima riga esterna.'));
    await wait(async () => (await text()).includes('Ultima riga esterna.'), 'Non-overlapping changes were not merged automatically');
    assert.match(await text(), /Prima riga locale/);
    await command('Save (Commit)');
    await wait(async () => (await readFile(chapter, 'utf8')).includes('Prima riga locale'), 'Merged file not saved');
    assert.match(await readFile(chapter, 'utf8'), /Ultima riga esterna/);
    assert.doesNotMatch(await readFile(chapter, 'utf8'), /<<<<<<<|>>>>>>>/);
    await wait(() => git(repo, 'diff', '--name-only') === '', 'Automatic merge not committed');
    const merged = await readFile(chapter, 'utf8');
    await edit(merged.replace('Prima riga locale.', 'Prima riga nuova locale.'));
    await writeFile(chapter, merged.replace('Prima riga locale.', 'Prima riga nuova esterna.'));
    await browser.$('button=Merge (3-way)').waitForExist({ timeout: 10000 });
    await clickText('Merge (3-way)');
    await wait(async () => (await text()).includes('<<<<<<<'), 'Conflicting edits were not exposed');
    await snapshot('external-conflict-before-resolution');
    assert.match(await text(), /Prima riga nuova locale/);
    assert.match(await text(), /Prima riga nuova esterna/);
    await edit(merged.replace('Prima riga locale.', 'Prima riga risolta insieme.'));
    await command('Save (Commit)');
    await wait(async () => (await readFile(chapter, 'utf8')).includes('risolta insieme'), 'Resolution not saved');
    assert.doesNotMatch(await readFile(chapter, 'utf8'), /<<<<<<<|>>>>>>>/);

  });
  await scenario('vim-accented-search-repeat-and-toggle', async () => {
    const vimFile = join(repo, 'vim.md');
    const original = 'città prima\ncittà seconda\ncittà terza';
    await writeFile(vimFile, original); await open(vimFile);
    await command('Enable Vim Keybindings');
    await browser.execute(() => document.querySelector('.cm-content').focus());
    await browser.keys('gg'); await browser.keys('/');
    await browser.$('.cm-vim-panel input').waitForExist();
    await browser.$('.cm-vim-panel input').setValue('città');
    await browser.keys(Key.Enter);
    await browser.$('.cm-vim-panel input').waitForExist({ reverse: true });
    const before = await browser.$('.statusbar').getText();
    await browser.keys('n');
    await wait(async () => (await browser.$('.statusbar').getText()) !== before, 'Vim n did not advance');
    await browser.keys('N');
    await wait(async () => (await browser.$('.statusbar').getText()) === before, 'Vim N did not return');
    await command('Disable Vim Keybindings'); await command('Enable Vim Keybindings');
    await browser.execute(() => document.querySelector('.cm-content').focus());
    await browser.keys('n');
    await wait(async () => (await browser.$('.statusbar').getText()) !== before, 'Vim repeat lost after toggle');
    assert.equal(await text(), original);
    assert.equal(await readFile(vimFile, 'utf8'), original);
    await command('Disable Vim Keybindings');
  });
  console.log(`Artifacts: ${run}`);
} catch (error) {
  await snapshot('failure').catch(() => {});
  if (!results.some(result => result.status === 'failed')) results.push({ name: 'harness', status: 'failed', error: error.stack });
  process.exitCode = 1;
  console.error(error);
} finally {
  await stop();
  server.closeAllConnections(); await new Promise(r => server.close(r));
  await writeFile(join(run, 'results.json'), JSON.stringify({ live, command: live ? 'npm run test:e2e:live' : 'npm run test:e2e', commit: git(resolve('.'), 'rev-parse', 'HEAD'), node: process.version, platform: process.platform, results, requests, frontendLogs }, null, 2));
  await writeFile(join(run, 'git.txt'), git(repo, 'log', '--all', '--oneline', '--graph'));
}
