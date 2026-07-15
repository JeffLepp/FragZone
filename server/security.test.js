const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const WebSocket = require('ws');

const ALLOWED_ORIGIN = 'https://game.example';

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['index.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: ALLOWED_ORIGIN,
        MAX_PLAYERS: '1',
        MAX_CONNECTIONS: '3',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code && !child.killed) reject(new Error(`server exited ${code}: ${stderr}`));
    });
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/127\.0\.0\.1:(\d+)/);
      if (match) resolve({ child, port: Number(match[1]), stderr: () => stderr });
    });
  });
}

function openSocket(url, origin = ALLOWED_ORIGIN, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function rejectedStatus(url, origin, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, headers });
    ws.once('open', () => {
      ws.close();
      reject(new Error('connection unexpectedly opened'));
    });
    ws.once('unexpected-response', (_request, response) => {
      const { statusCode } = response;
      response.resume();
      resolve(statusCode);
    });
    ws.once('error', () => {});
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', raw => {
      try { resolve(JSON.parse(raw.toString('utf8'))); }
      catch (error) { reject(error); }
    });
    ws.once('error', reject);
  });
}

function nextClose(ws) {
  return new Promise(resolve => ws.once('close', (code, reason) => {
    resolve({ code, reason: reason.toString() });
  }));
}

test('public-server security boundaries', { timeout: 15000 }, async t => {
  const runtime = await startServer();
  const base = `http://127.0.0.1:${runtime.port}`;
  const socketUrl = `ws://127.0.0.1:${runtime.port}`;

  t.after(async () => {
    if (runtime.child.exitCode == null) {
      runtime.child.kill('SIGTERM');
      await new Promise(resolve => runtime.child.once('exit', resolve));
    }
  });

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await fetch(`${base}/metrics`, {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  })).status, 404);

  assert.equal(await rejectedStatus(socketUrl, 'https://evil.example'), 403);

  const invalid = await openSocket(socketUrl);
  const invalidClosed = nextClose(invalid);
  invalid.send('null');
  assert.equal((await invalidClosed).code, 1007);

  const oversized = await openSocket(socketUrl);
  const oversizedInit = nextMessage(oversized);
  oversized.send(JSON.stringify({ type: 'join', name: 'payload-test' }));
  assert.equal((await oversizedInit).type, 'init');
  const oversizedClosed = nextClose(oversized);
  oversized.send(JSON.stringify({ type: 'noop', padding: 'x'.repeat(20 * 1024) }));
  assert.equal((await oversizedClosed).code, 1009);

  // Spoofing the first X-Forwarded-For entry must not dodge the per-IP cap:
  // only the proxy-appended last hop identifies the client.
  const spoofer = await openSocket(socketUrl, ALLOWED_ORIGIN,
    { 'x-forwarded-for': 'fake-a, 198.51.100.7' });
  assert.equal(await rejectedStatus(socketUrl, ALLOWED_ORIGIN,
    { 'x-forwarded-for': 'fake-b, 198.51.100.7' }), 429);
  const spooferClosed = nextClose(spoofer);
  spoofer.close();
  await spooferClosed;

  const player = await openSocket(socketUrl);
  const init = nextMessage(player);
  player.send(JSON.stringify({ type: 'join', name: 'a.d.m.1.n' }));
  const initMessage = await init;
  assert.equal(initMessage.type, 'init');
  assert.equal(initMessage.scores[initMessage.id].name, 'Anon');
  assert.equal(await rejectedStatus(socketUrl, ALLOWED_ORIGIN), 503);

  const rateClosed = nextClose(player);
  for (let i = 0; i <= 80; i++) player.send(JSON.stringify({ type: 'noop' }));
  assert.equal((await rateClosed).code, 1008);

  assert.equal(runtime.child.exitCode, null, runtime.stderr());
});
