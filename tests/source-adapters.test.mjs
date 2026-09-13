import assert from 'node:assert/strict';
import test from 'node:test';

import { acquireResource } from '../src/mastra/resources/source-adapters.ts';

const never = async () => {
  throw new Error('Unexpected adapter call.');
};

test('Google Docs adapter uses exact read slugs and normalizes plaintext', async () => {
  const calls = [];
  const envelope = await acquireResource(
    { kind: 'google-doc', id: '1AbCdEfGhIjKlMnOpQr' },
    {
      dependencies: {
        googleDocsExecute: async (slug, args) => {
          calls.push([slug, args]);
          return slug === 'GOOGLEDOCS_GET_DOCUMENT_BY_ID'
            ? { document: { title: 'Lab report', revisionId: 'rev-7' } }
            : { text: 'Validated document evidence.' };
        },
        linearExecute: never,
        trelloExecute: never,
        now: () => new Date('2026-08-16T12:00:00.000Z'),
      },
    },
  );

  assert.deepEqual(calls.map(([slug]) => slug), [
    'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
    'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
  ]);
  assert.deepEqual(calls[0][1], { document_id: '1AbCdEfGhIjKlMnOpQr' });
  assert.equal(envelope.title, 'Lab report');
  assert.equal(envelope.revision, 'rev-7');
  assert.equal(envelope.content, 'Validated document evidence.');
});

test('Linear and Trello adapters include status, labels, and comments', async () => {
  const linearCalls = [];
  const linear = await acquireResource(
    { kind: 'linear-issue', id: 'ENG-123' },
    {
      dependencies: {
        googleDocsExecute: never,
        trelloExecute: never,
        linearExecute: async (slug, args) => {
          linearCalls.push([slug, args]);
          return slug === 'LINEAR_GET_LINEAR_ISSUE'
            ? {
                issue: {
                  title: 'Repair fetching',
                  description: 'Use bounded requests.',
                  state: { name: 'In Progress' },
                  labels: [{ name: 'security' }],
                  url: 'https://linear.app/acme/issue/ENG-123/repair-fetching',
                  updatedAt: '2026-08-16T10:00:00.000Z',
                },
              }
            : { comments: [{ body: 'Add redirect tests.', author: { fullName: 'Ada' } }] };
        },
      },
    },
  );
  assert.deepEqual(linearCalls.map(([slug]) => slug), [
    'LINEAR_GET_LINEAR_ISSUE',
    'LINEAR_LIST_COMMENTS',
  ]);
  assert.match(linear.content, /Status\nIn Progress/);
  assert.match(linear.content, /Labels\nsecurity/);
  assert.match(linear.content, /Ada: Add redirect tests/);

  const trelloCalls = [];
  const trello = await acquireResource(
    { kind: 'trello-card', id: 'AbC123xy' },
    {
      dependencies: {
        googleDocsExecute: never,
        linearExecute: never,
        trelloExecute: async (slug, args) => {
          trelloCalls.push([slug, args]);
          return slug === 'TRELLO_GET_CARDS_BY_ID_CARD'
            ? {
                card: {
                  name: 'Static web gateway',
                  desc: 'Extract readable text.',
                  board: { name: 'Mentor' },
                  list: { name: 'Doing' },
                  labels: [{ name: 'RAG' }],
                  shortUrl: 'https://trello.com/c/AbC123xy',
                },
              }
            : {
                data: [
                  { data: { text: 'Keep source content untrusted.' }, memberCreator: { fullName: 'Bo' } },
                ],
                successful: true,
              };
        },
      },
    },
  );
  assert.deepEqual(trelloCalls.map(([slug]) => slug), [
    'TRELLO_GET_CARDS_BY_ID_CARD',
    'TRELLO_GET_CARDS_ACTIONS_BY_ID_CARD',
  ]);
  assert.match(trello.content, /Board\nMentor/);
  assert.match(trello.content, /Bo: Keep source content untrusted/);
});

test('web adapter indexes only successful normalized acquisitions', async () => {
  const envelope = await acquireResource(
    { kind: 'web', url: 'https://example.com/redirect' },
    {
      dependencies: {
        googleDocsExecute: never,
        linearExecute: never,
        trelloExecute: never,
        acquirePage: async () => ({
          ok: true,
          requestedUrl: 'https://example.com/redirect',
          url: 'https://example.com/article',
          canonicalUrl: 'https://example.com/canonical',
          title: 'Example article',
          status: 200,
          statusText: 'OK',
          contentType: 'text/html',
          text: 'Adapter-validated page text.',
          extractor: 'readability',
          bytes: 120,
          truncated: false,
          warnings: [],
        }),
      },
    },
  );

  assert.equal(envelope.sourceId, 'https://example.com/canonical');
  assert.equal(envelope.canonicalUrl, 'https://example.com/canonical');
  assert.equal(envelope.metadata.extractor, 'readability');
});
