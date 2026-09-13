import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createResourceEnvelope,
  ResourceAcquisitionError,
} from '../src/mastra/resources/contracts.ts';
import {
  ingestOneResource,
  ingestResourceBatch,
} from '../src/mastra/workflows/ingest-resources.ts';

function envelopeFor(source, content = 'Evidence '.repeat(1_200)) {
  return createResourceEnvelope({
    sourceType: source.kind,
    sourceId: source.url ?? source.id,
    title: 'Indexed source',
    canonicalUrl: source.url ?? `https://example.com/${source.id}`,
    revision: 'rev-1',
    retrievedAt: '2026-08-16T12:00:00.000Z',
    content,
    metadata: { provider: 'test' },
  });
}

test('embeds before replacement and upserts stable IDs with citation metadata', async () => {
  const source = { kind: 'web', url: 'https://example.com/article' };
  const events = [];
  const upserts = [];
  const store = {
    createIndex: async params => events.push(['create', params]),
    deleteVectors: async params => events.push(['delete', params]),
    upsert: async params => {
      events.push(['upsert']);
      upserts.push(params);
      return params.ids;
    },
  };
  const dependencies = {
    acquire: async value => envelopeFor(value),
    embed: async values => {
      events.push(['embed', values.length]);
      return values.map((_value, index) => Array(1536).fill(index / 10));
    },
    getVectorStore: () => store,
    getIndexName: () => 'mentor-test',
  };

  const first = await ingestOneResource(source, { dependencies });
  const firstIds = [...upserts[0].ids];
  const second = await ingestOneResource(source, { dependencies });

  assert.equal(first.status, 'indexed');
  assert.equal(second.status, 'indexed');
  assert.ok(first.chunkCount > 1);
  assert.ok(events.findIndex(([name]) => name === 'embed') < events.findIndex(([name]) => name === 'delete'));
  assert.deepEqual(upserts[1].ids, firstIds);
  assert.equal(upserts[0].metadata[0].canonicalUrl, source.url);
  assert.equal(upserts[0].metadata[0].text.length > 0, true);
  assert.equal(upserts[0].metadata[0].contentHash, first.contentHash);
});

test('a failed source does not prevent another batch item from indexing', async () => {
  const missing = { kind: 'linear-issue', id: 'ENG-404' };
  const available = { kind: 'web', url: 'https://example.com/available' };
  const store = {
    createIndex: async () => {},
    deleteVectors: async () => {},
    upsert: async ({ ids }) => ids,
  };
  const results = await ingestResourceBatch([missing, available], {
    dependencies: {
      acquire: async source => {
        if (source === missing) {
          throw new ResourceAcquisitionError('SOURCE_NOT_FOUND', 'Issue not found.');
        }
        return envelopeFor(source, 'Available evidence.');
      },
      embed: async values => values.map(() => Array(1536).fill(0)),
      getVectorStore: () => store,
      getIndexName: () => 'mentor-test',
    },
  });

  assert.deepEqual(results.map(result => result.status), ['failed', 'indexed']);
  assert.equal(results[0].errorCode, 'SOURCE_NOT_FOUND');
  assert.equal(results[1].chunkCount, 1);
});

test('reports an unavailable index separately from successful source acquisition', async () => {
  const source = { kind: 'web', url: 'https://example.com/article' };
  const connectionError = new Error('');
  connectionError.name = 'ConnectionError';
  const result = await ingestOneResource(source, {
    dependencies: {
      acquire: async value => envelopeFor(value, 'Acquired evidence.'),
      embed: async () => {
        throw new Error('Embeddings must not run before index validation.');
      },
      getVectorStore: () => ({
        createIndex: async () => {
          throw new Error('', { cause: connectionError });
        },
        deleteVectors: async () => {},
        upsert: async ({ ids }) => ids,
      }),
      getIndexName: () => 'mentor-test',
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'INDEX_UNAVAILABLE');
  assert.match(result.message, /source was acquired/i);
});
