import { executeGoogleDocsTool } from '../mcp/google-docs-client';
import { executeLinearTool } from '../mcp/linear-client';
import { executeTrelloTool } from '../mcp/trello-client';
import {
  createResourceEnvelope,
  ResourceAcquisitionError,
  type ResourceEnvelope,
  type ResourceErrorCode,
  type SourceRef,
} from './contracts';
import { acquirePage, type PageAcquisitionResult } from './web-acquisition';

type ExecuteProviderTool = (
  toolSlug: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

export type SourceAdapterDependencies = {
  googleDocsExecute: ExecuteProviderTool;
  linearExecute: ExecuteProviderTool;
  trelloExecute: ExecuteProviderTool;
  acquirePage: typeof acquirePage;
  now: () => Date;
};

const defaultDependencies: SourceAdapterDependencies = {
  googleDocsExecute: executeGoogleDocsTool,
  linearExecute: executeLinearTool,
  trelloExecute: executeTrelloTool,
  acquirePage,
  now: () => new Date(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapData(value: unknown): unknown {
  let current = value;
  const wrapperKeys = new Set(['data', 'successful', 'success', 'error', 'logId', 'message']);
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      !isRecord(current) ||
      !('data' in current) ||
      current.data === undefined ||
      !Object.keys(current).every(key => wrapperKeys.has(key))
    ) {
      break;
    }
    current = current.data;
  }
  return current;
}

function findRecord(value: unknown, preferredKeys: string[]): Record<string, unknown> | undefined {
  const unwrapped = unwrapData(value);
  if (!isRecord(unwrapped)) return undefined;

  for (const key of preferredKeys) {
    const candidate = unwrapData(unwrapped[key]);
    if (isRecord(candidate)) return candidate;
  }
  return unwrapped;
}

function findString(
  value: unknown,
  keys: string[],
  maxDepth = 3,
): string | undefined {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: unwrapData(value), depth: 0 }];
  const seen = new Set<unknown>();

  while (queue.length) {
    const next = queue.shift();
    if (!next || seen.has(next.value)) continue;
    seen.add(next.value);
    if (!isRecord(next.value)) continue;

    for (const key of keys) {
      const candidate = next.value[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }

    if (next.depth >= maxDepth) continue;
    for (const nested of Object.values(next.value)) {
      if (isRecord(nested)) queue.push({ value: nested, depth: next.depth + 1 });
    }
  }
  return undefined;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = unwrapData(value);
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function arrayAtAnyPath(value: unknown, paths: string[][]): unknown[] {
  const direct = unwrapData(value);
  if (Array.isArray(direct)) return direct;

  for (const path of paths) {
    const candidate = unwrapData(valueAt(value, path));
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function collectionItems(value: unknown): unknown[] {
  const unwrapped = unwrapData(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  if (!isRecord(unwrapped)) return [];

  for (const key of ['nodes', 'items', 'edges']) {
    const candidate = unwrapped[key];
    if (Array.isArray(candidate)) {
      return key === 'edges'
        ? candidate.map(item => (isRecord(item) && 'node' in item ? item.node : item))
        : candidate;
    }
  }
  return [];
}

function namesFromCollection(value: unknown): string[] {
  return collectionItems(value)
    .map(item => {
      if (typeof item === 'string') return item.trim();
      return findString(item, ['name', 'title', 'label'], 1);
    })
    .filter((item): item is string => Boolean(item));
}

function section(label: string, value: string | undefined): string | undefined {
  return value?.trim() ? `${label}\n${value.trim()}` : undefined;
}

function formatComments(value: unknown): string | undefined {
  const comments = arrayAtAnyPath(value, [
    ['comments'],
    ['nodes'],
    ['items'],
    ['actions'],
    ['data', 'comments'],
    ['data', 'nodes'],
    ['data', 'actions'],
  ]);
  const lines = comments
    .map(comment => {
      const body = findString(comment, ['body', 'text', 'content', 'description'], 3);
      if (!body) return undefined;
      const author = findString(comment, ['displayName', 'fullName', 'authorName'], 3);
      return author ? `${author}: ${body}` : body;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length ? lines.join('\n\n') : undefined;
}

function revisionFrom(value: unknown): string | undefined {
  return findString(value, [
    'revisionId',
    'revision_id',
    'modifiedTime',
    'updatedAt',
    'updated_at',
    'dateLastActivity',
  ]);
}

function wrapProviderError(provider: string, error: unknown): never {
  if (error instanceof ResourceAcquisitionError) throw error;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
    throw new ResourceAcquisitionError('TIMEOUT', `${provider} acquisition was aborted or timed out.`, {
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : `${provider} acquisition failed.`;
  const notFound = /\b(?:404|not found|does not exist)\b/i.test(message);
  throw new ResourceAcquisitionError(
    notFound ? 'SOURCE_NOT_FOUND' : 'SOURCE_UNAVAILABLE',
    notFound ? `${provider} resource was not found.` : `${provider} resource could not be read.`,
    { cause: error },
  );
}

async function acquireGoogleDocument(
  source: Extract<SourceRef, { kind: 'google-doc' }>,
  signal: AbortSignal | undefined,
  dependencies: SourceAdapterDependencies,
): Promise<ResourceEnvelope> {
  try {
    const [documentResult, plaintextResult] = await Promise.all([
      dependencies.googleDocsExecute(
        'GOOGLEDOCS_GET_DOCUMENT_BY_ID',
        { document_id: source.id },
        signal,
      ),
      dependencies.googleDocsExecute(
        'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
        { document_id: source.id },
        signal,
      ),
    ]);
    const document = findRecord(documentResult, ['document']);
    const title = findString(document, ['title', 'name'], 2) ?? `Google Doc ${source.id}`;
    const content = findString(
      plaintextResult,
      ['plainText', 'plain_text', 'plaintext', 'text', 'content'],
      4,
    );
    if (!content) {
      throw new ResourceAcquisitionError(
        'EMPTY_CONTENT',
        'The Google document contains no plaintext content.',
      );
    }

    return createResourceEnvelope({
      sourceType: 'google-doc',
      sourceId: source.id,
      title,
      canonicalUrl: `https://docs.google.com/document/d/${source.id}/edit`,
      ...(revisionFrom(documentResult) ? { revision: revisionFrom(documentResult) } : {}),
      retrievedAt: dependencies.now().toISOString(),
      content,
      metadata: { provider: 'googledocs' },
    });
  } catch (error) {
    return wrapProviderError('Google Docs', error);
  }
}

async function acquireLinearIssue(
  source: Extract<SourceRef, { kind: 'linear-issue' }>,
  signal: AbortSignal | undefined,
  dependencies: SourceAdapterDependencies,
): Promise<ResourceEnvelope> {
  try {
    const [issueResult, commentsResult] = await Promise.all([
      dependencies.linearExecute('LINEAR_GET_LINEAR_ISSUE', { issue_id: source.id }, signal),
      dependencies.linearExecute('LINEAR_LIST_COMMENTS', { issue_id: source.id }, signal),
    ]);
    const issue = findRecord(issueResult, ['issue']);
    const title = findString(issue, ['title', 'name'], 2);
    if (!issue || !title) {
      throw new ResourceAcquisitionError('SOURCE_NOT_FOUND', 'The Linear issue was not found.');
    }
    const description = findString(issue, ['description', 'body'], 2);
    const status = findString(valueAt(issue, ['state']), ['name', 'title'], 1)
      ?? findString(issue, ['status'], 1);
    const labels = namesFromCollection(valueAt(issue, ['labels']));
    const comments = formatComments(commentsResult);
    const content = [
      section('Title', title),
      section('Description', description),
      section('Status', status),
      section('Labels', labels.length ? labels.join(', ') : undefined),
      section('Comments', comments),
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
    const canonicalUrl =
      findString(issue, ['url', 'webUrl', 'web_url'], 2) ??
      `https://linear.app/issue/${encodeURIComponent(source.id)}`;
    const revision = revisionFrom(issue);

    return createResourceEnvelope({
      sourceType: 'linear-issue',
      sourceId: source.id,
      title,
      canonicalUrl,
      ...(revision ? { revision } : {}),
      retrievedAt: dependencies.now().toISOString(),
      content,
      metadata: {
        provider: 'linear',
        ...(status ? { status } : {}),
        ...(labels.length ? { labels: labels.join(', ') } : {}),
      },
    });
  } catch (error) {
    return wrapProviderError('Linear', error);
  }
}

async function acquireTrelloCard(
  source: Extract<SourceRef, { kind: 'trello-card' }>,
  signal: AbortSignal | undefined,
  dependencies: SourceAdapterDependencies,
): Promise<ResourceEnvelope> {
  try {
    const [cardResult, actionsResult] = await Promise.all([
      dependencies.trelloExecute(
        'TRELLO_GET_CARDS_BY_ID_CARD',
        { idCard: source.id, board: 'true', list: 'true' },
        signal,
      ),
      dependencies.trelloExecute(
        'TRELLO_GET_CARDS_ACTIONS_BY_ID_CARD',
        { idCard: source.id, filter: 'commentCard' },
        signal,
      ),
    ]);
    const card = findRecord(cardResult, ['card']);
    const title = findString(card, ['name', 'title'], 2);
    if (!card || !title) {
      throw new ResourceAcquisitionError('SOURCE_NOT_FOUND', 'The Trello card was not found.');
    }
    const description = findString(card, ['desc', 'description'], 2);
    const board = findString(valueAt(card, ['board']), ['name', 'title'], 1);
    const list = findString(valueAt(card, ['list']), ['name', 'title'], 1);
    const labels = namesFromCollection(valueAt(card, ['labels']));
    const comments = formatComments(actionsResult);
    const content = [
      section('Card', title),
      section('Description', description),
      section('Board', board),
      section('List', list),
      section('Labels', labels.length ? labels.join(', ') : undefined),
      section('Comments', comments),
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
    const canonicalUrl =
      findString(card, ['url', 'shortUrl', 'short_url'], 2) ??
      `https://trello.com/c/${encodeURIComponent(source.id)}`;
    const revision = revisionFrom(card);

    return createResourceEnvelope({
      sourceType: 'trello-card',
      sourceId: source.id,
      title,
      canonicalUrl,
      ...(revision ? { revision } : {}),
      retrievedAt: dependencies.now().toISOString(),
      content,
      metadata: {
        provider: 'trello',
        ...(board ? { board } : {}),
        ...(list ? { list } : {}),
        ...(labels.length ? { labels: labels.join(', ') } : {}),
      },
    });
  } catch (error) {
    return wrapProviderError('Trello', error);
  }
}

function failureCode(result: Extract<PageAcquisitionResult, { ok: false }>): ResourceErrorCode {
  return result.code;
}

async function acquireWebPage(
  source: Extract<SourceRef, { kind: 'web' }>,
  signal: AbortSignal | undefined,
  dependencies: SourceAdapterDependencies,
): Promise<ResourceEnvelope> {
  const result = await dependencies.acquirePage(source.url, { abortSignal: signal });
  if (!result.ok) {
    throw new ResourceAcquisitionError(failureCode(result), result.message);
  }
  const canonicalUrl = result.canonicalUrl ?? result.url;
  const parsed = new URL(canonicalUrl);

  return createResourceEnvelope({
    sourceType: 'web',
    sourceId: canonicalUrl,
    title: result.title ?? parsed.hostname,
    canonicalUrl,
    retrievedAt: dependencies.now().toISOString(),
    content: result.text,
    metadata: {
      extractor: result.extractor,
      responseBytes: result.bytes,
      truncated: result.truncated,
      status: result.status,
      contentType: result.contentType ?? '',
    },
  });
}

export async function acquireResource(
  source: SourceRef,
  options: {
    signal?: AbortSignal;
    dependencies?: Partial<SourceAdapterDependencies>;
  } = {},
): Promise<ResourceEnvelope> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  switch (source.kind) {
    case 'google-doc':
      return acquireGoogleDocument(source, options.signal, dependencies);
    case 'linear-issue':
      return acquireLinearIssue(source, options.signal, dependencies);
    case 'trello-card':
      return acquireTrelloCard(source, options.signal, dependencies);
    case 'web':
      return acquireWebPage(source, options.signal, dependencies);
  }
}
