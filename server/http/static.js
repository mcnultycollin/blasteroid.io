/**
 * Static file serving from an allow-list built at startup: request paths are
 * only ever looked up in a Map, never joined onto the filesystem, so path
 * traversal is impossible by construction. In production every file is held
 * in memory with precomputed gzip/brotli variants and ETags; in development
 * files are read fresh on each request so edits show up on reload.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);

/** Exact routes and directory mounts, relative to the project root. */
const ROUTES = [
  ['/', 'public/index.html'],
  ['/play', 'public/play.html'],
  ['/demo', 'public/play.html'], // original "Play Alpha" link
];
const MOUNTS = [
  ['/static/', 'public/static'],
  ['/client/', 'client'],
  ['/shared/', 'shared'],
];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && TYPES[path.extname(entry.name)]) out.push(full);
  }
  return out;
}

async function buildFileMap(root) {
  const files = new Map();
  for (const [url, rel] of ROUTES) files.set(url, path.join(root, rel));
  for (const [prefix, rel] of MOUNTS) {
    const dir = path.join(root, rel);
    for (const file of await walk(dir)) {
      files.set(prefix + path.relative(dir, file).split(path.sep).join('/'), file);
    }
  }
  return files;
}

async function loadAsset(file) {
  const ext = path.extname(file);
  const body = await readFile(file);
  const asset = {
    type: TYPES[ext],
    body,
    etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
    gzip: null,
    br: null,
  };
  if (COMPRESSIBLE.has(ext) && body.length > 512) {
    asset.gzip = await gzip(body, { level: 9 });
    asset.br = await brotli(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
  }
  return asset;
}

export async function createStaticHandler({ root, production }) {
  let files = await buildFileMap(root);
  const cache = new Map();
  if (production) {
    for (const [url, file] of files) cache.set(url, await loadAsset(file));
  }

  async function resolve(pathname) {
    if (production) return cache.get(pathname) ?? null;
    let file = files.get(pathname);
    if (!file) {
      files = await buildFileMap(root); // pick up files added since startup
      file = files.get(pathname);
      if (!file) return null;
    }
    const info = await stat(file);
    return {
      type: TYPES[path.extname(file)],
      body: await readFile(file),
      etag: `W/"${info.size.toString(36)}-${info.mtimeMs.toString(36)}"`,
      gzip: null,
      br: null,
    };
  }

  return async function serveStatic(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      const asset = await resolve(pathname);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      const headers = {
        'Content-Type': asset.type,
        'Cache-Control': 'no-cache', // always revalidate; unchanged files cost a 304
        ETag: asset.etag,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      };
      if (req.headers['if-none-match'] === asset.etag) {
        res.writeHead(304, headers).end();
        return;
      }
      let body = asset.body;
      if (asset.gzip) {
        headers.Vary = 'Accept-Encoding';
        const accept = req.headers['accept-encoding'] || '';
        if (asset.br && /\bbr\b/.test(accept)) {
          body = asset.br;
          headers['Content-Encoding'] = 'br';
        } else if (/\bgzip\b/.test(accept)) {
          body = asset.gzip;
          headers['Content-Encoding'] = 'gzip';
        }
      }
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    }
  };
}
