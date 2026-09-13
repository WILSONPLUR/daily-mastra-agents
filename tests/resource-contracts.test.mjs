import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createChunkId,
  createResourceEnvelope,
  parseSourceUrl,
  sourceRefSchema,
} from '../src/mastra/resources/contracts.ts';

test('routes provider URLs to typed references before generic web', () => {
  assert.deepEqual(
    parseSourceUrl(
      'https://docs.google.com/document/u/0/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
    ),
    { kind: 'google-doc', id: '1AbCdEfGhIjKlMnOpQrStUvWxYz' },
  );
  assert.deepEqual(
    parseSourceUrl('https://linear.app/acme/issue/ENG-123/fix-fetching'),
    { kind: 'linear-issue', id: 'ENG-123' },
  );
  assert.deepEqual(parseSourceUrl('https://trello.com/c/AbC123xy/example-card'), {
    kind: 'trello-card',
    id: 'AbC123xy',
  });
  assert.deepEqual(parseSourceUrl('https://example.com/article'), {
    kind: 'web',
    url: 'https://example.com/article',
  });
});

test('rejects malformed IDs, credentials, and unsupported URL schemes', () => {
  assert.equal(parseSourceUrl('https://docs.google.com/document/d/short/edit'), undefined);
  assert.equal(parseSourceUrl('file:///tmp/document.txt'), undefined);
  assert.equal(
    sourceRefSchema.safeParse({ kind: 'web', url: 'https://user:pass@example.com' }).success,
    false,
  );
  assert.equal(
    sourceRefSchema.safeParse({
      kind: 'web',
      url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQr/edit',
    }).success,
    false,
  );
});

test('source, content, and chunk identities are stable', () => {
  const base = {
    sourceType: 'web',
    sourceId: 'https://example.com/article',
    title: 'Example',
    canonicalUrl: 'https://example.com/article',
    retrievedAt: '2026-08-16T12:00:00.000Z',
    content: 'Line one.\r\n\r\n\r\nLine two.',
    metadata: { provider: 'web' },
  };
  const first = createResourceEnvelope(base);
  const second = createResourceEnvelope({ ...base, retrievedAt: '2026-08-17T12:00:00.000Z' });

  assert.equal(first.sourceKey, second.sourceKey);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(createChunkId(first.sourceKey, 0), createChunkId(second.sourceKey, 0));
  assert.notEqual(createChunkId(first.sourceKey, 0), createChunkId(first.sourceKey, 1));
});
