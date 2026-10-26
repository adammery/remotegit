// Browser preview of the UI without Tauri: `npm run preview`, then open
// http://localhost:1420. Commands run in a local `sh` instead of over SSH, so
// "servers" you add here are this machine. Set PREVIEW_HOME to change $HOME
// for those commands. Development only — binds to 127.0.0.1.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const port = Number(process.env.PORT || 1420);
const env = { ...process.env, ...(process.env.PREVIEW_HOME ? { HOME: process.env.PREVIEW_HOME } : {}) };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const shim = `<script>
window.__TAURI__ = {
  core: {
    async invoke(cmd, args) {
      const r = await fetch('/invoke', { method: 'POST', body: JSON.stringify({ cmd, args }) });
      const body = await r.json();
      if (!r.ok) throw body.error;
      return body.result;
    },
  },
  opener: { async openUrl(url) { console.log('[preview] open', url); } },
};
</script>`;

// Like the SSH session: big scripts can't be a single exec argument, so they run from a file.
async function sh(script, timeoutSecs = 60) {
  if (script.length <= 64 * 1024) return run(['-c', script], timeoutSecs);
  const dir = await mkdtemp(join(tmpdir(), 'remotegit-'));
  try {
    await writeFile(join(dir, 'script.sh'), script);
    return await run([join(dir, 'script.sh')], timeoutSecs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(args, timeoutSecs) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const timer = setTimeout(() => {
      child.kill();
      reject(`Timed out after ${timeoutSecs}s`);
    }, timeoutSecs * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code: code ?? -1 });
    });
  });
}

const handlers = {
  async ssh_connect({ target }) {
    await new Promise((r) => setTimeout(r, 300));
    if (target.host === 'fail.example') throw 'ssh: connect to host fail.example port 22: Connection refused';
    return null;
  },
  ssh_exec: ({ script, timeoutSecs }) => sh(script, timeoutSecs || 60),
  ssh_disconnect: () => null,
  show_main_window: () => null,
  set_tray_status: ({ title }) => (console.log('[preview] tray title', JSON.stringify(title)), null),
  set_menu_bar_only: () => null,
};

createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/invoke') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { cmd, args } = JSON.parse(body);
      try {
        const result = await handlers[cmd](args);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
      }
      return;
    }
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    let data = await readFile(file);
    if (file.endsWith('.html')) data = data.toString().replace('<script type="module"', `${shim}\n    <script type="module"`);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`RemoteGit preview on http://localhost:${port}`));
