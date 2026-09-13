import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquirePage,
  isPublicIpAddress,
} from '../src/mastra/resources/web-acquisition.ts';
import { webFetchTool } from '../src/mastra/tools/web-fetch-tool.ts';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('tool execution remains functional when the API supplies no observer', async () => {
  const result = await webFetchTool.execute(
    { url: 'http://127.0.0.1/' },
    { abortSignal: undefined, observe: undefined },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BLOCKED_TARGET');
});

test('extracts readable HTML and preserves final and canonical URLs', async () => {
  let requestHeaders;
  const html = `<!doctype html><html><head>
    <title>Useful page</title>
    <link rel="canonical" href="/canonical">
    <style>.hidden{display:none}</style>
  </head><body><nav>Navigation noise</nav><article><h1>Useful page</h1>
    <p>${'Evidence-rich paragraph for extraction. '.repeat(8)}</p>
  </article><script>window.secret = true</script></body></html>`;
  const result = await acquirePage('https://example.com/start', {
    lookup: publicLookup,
    fetch: async (_url, init) => {
      requestHeaders = init.headers;
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://example.com/start');
  assert.equal(result.canonicalUrl, 'https://example.com/canonical');
  assert.match(result.text, /Evidence-rich paragraph/);
  assert.doesNotMatch(result.text, /Navigation noise|window\.secret/);
  assert.equal(result.extractor, 'readability');
  assert.match(requestHeaders['user-agent'], /^Mozilla\/5\.0/);
  assert.equal(requestHeaders['accept-language'], 'en-US,en;q=0.9');
});

test('manually follows redirects and validates the new target', async () => {
  const lookedUp = [];
  const result = await acquirePage('https://example.com/start', {
    lookup: async hostname => {
      lookedUp.push(hostname);
      return hostname === 'internal.example'
        ? [{ address: '10.0.0.7', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];
    },
    fetch: async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://internal.example/secret' },
      }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BLOCKED_TARGET');
  assert.deepEqual(lookedUp, ['example.com', 'internal.example']);
});

test('rejects private, reserved, mapped, and mixed DNS answers', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('93.184.216.34'), true);

  const literal = await acquirePage('http://[::1]/', {
    fetch: async () => new Response('must not run'),
  });
  assert.equal(literal.ok, false);
  assert.equal(literal.code, 'BLOCKED_TARGET');

  const mixed = await acquirePage('https://rebind.example/', {
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.2', family: 4 },
    ],
    fetch: async () => new Response('must not run'),
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, 'BLOCKED_TARGET');
});

test('supports JSON and text truncation and rejects binary or oversized bodies', async () => {
  const json = await acquirePage('https://example.com/data', {
    lookup: publicLookup,
    fetch: async () =>
      new Response('{"answer":42}', { headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(json.ok, true);
  assert.equal(json.text, '{\n  "answer": 42\n}');

  const truncated = await acquirePage('https://example.com/text', {
    lookup: publicLookup,
    maxTextCharacters: 10,
    fetch: async () =>
      new Response('abcdefghijklmnopqrstuvwxyz', { headers: { 'content-type': 'text/plain' } }),
  });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.text, 'abcdefghij');
  assert.equal(truncated.truncated, true);

  const binary = await acquirePage('https://example.com/image', {
    lookup: publicLookup,
    fetch: async () =>
      new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }),
  });
  assert.equal(binary.ok, false);
  assert.equal(binary.code, 'UNSUPPORTED_CONTENT_TYPE');

  const large = await acquirePage('https://example.com/large', {
    lookup: publicLookup,
    maxBodyBytes: 5,
    fetch: async () =>
      new Response('123456', {
        headers: { 'content-type': 'text/plain', 'content-length': '6' },
      }),
  });
  assert.equal(large.ok, false);
  assert.equal(large.code, 'TOO_LARGE');
});

test('returns structured HTTP, timeout, and JavaScript-shell failures', async () => {
  const http = await acquirePage('https://example.com/missing', {
    lookup: publicLookup,
    fetch: async () =>
      new Response('missing', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/plain' } }),
  });
  assert.equal(http.ok, false);
  assert.equal(http.code, 'HTTP_ERROR');
  assert.equal(http.status, 404);

  const shell = await acquirePage('https://example.com/app', {
    lookup: publicLookup,
    fetch: async () =>
      new Response('<html><body><div id="root">Loading</div><script src="app.js"></script></body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
  });
  assert.equal(shell.ok, false);
  assert.equal(shell.code, 'RENDER_REQUIRED');

  const timeout = await acquirePage('https://example.com/slow', {
    lookup: publicLookup,
    timeoutMs: 5,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.code, 'TIMEOUT');

  const dnsTimeout = await acquirePage('https://slow-dns.example/', {
    timeoutMs: 5,
    lookup: async () => new Promise(() => {}),
    fetch: async () => new Response('must not run'),
  });
  assert.equal(dnsTimeout.ok, false);
  assert.equal(dnsTimeout.code, 'TIMEOUT');
});
