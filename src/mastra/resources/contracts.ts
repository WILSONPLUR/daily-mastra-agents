import { createHash } from 'node:crypto';

import { z } from 'zod';

const googleDocumentIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{10,}$/, 'Invalid Google document ID.');

const providerResourceIdSchema = z.string().trim().min(1).max(200);

const publicWebUrlSchema = z
  .url()
  .superRefine((value, context) => {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      context.addIssue({
        code: 'custom',
        message: 'Web resources must use HTTP or HTTPS.',
      });
    }
    if (parsed.username || parsed.password) {
      context.addIssue({
        code: 'custom',
        message: 'URLs containing credentials are not supported.',
      });
    }
    const isProviderResource =
      (parsed.hostname === 'docs.google.com' &&
        /\/document\/(?:u\/\d+\/)?d\/[^/]+/.test(parsed.pathname)) ||
      ((parsed.hostname === 'linear.app' || parsed.hostname.endsWith('.linear.app')) &&
        /\/issue\/[^/]+/.test(parsed.pathname)) ||
      ((parsed.hostname === 'trello.com' || parsed.hostname.endsWith('.trello.com')) &&
        /\/c\/[^/]+/.test(parsed.pathname));
    if (isProviderResource) {
      context.addIssue({
        code: 'custom',
        message: 'Connected-provider URLs must use their provider-specific source kind.',
      });
    }
  });

export const sourceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('google-doc'), id: googleDocumentIdSchema }),
  z.object({ kind: z.literal('linear-issue'), id: providerResourceIdSchema }),
  z.object({ kind: z.literal('trello-card'), id: providerResourceIdSchema }),
  z.object({ kind: z.literal('web'), url: publicWebUrlSchema }),
]);

export type SourceRef = z.infer<typeof sourceRefSchema>;

const resourceMetadataValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const resourceEnvelopeSchema = z.object({
  sourceKey: z.string().min(1),
  sourceType: z.enum(['google-doc', 'linear-issue', 'trello-card', 'web']),
  sourceId: z.string().min(1),
  title: z.string().min(1),
  canonicalUrl: z.url(),
  revision: z.string().min(1).optional(),
  retrievedAt: z.iso.datetime(),
  content: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: z.record(z.string(), resourceMetadataValueSchema),
});

export type ResourceEnvelope = z.infer<typeof resourceEnvelopeSchema>;

export const ingestionResultSchema = z.object({
  source: sourceRefSchema,
  status: z.enum(['indexed', 'failed']),
  sourceKey: z.string().optional(),
  canonicalUrl: z.url().optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  chunkCount: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
  message: z.string().optional(),
});

export type IngestionResult = z.infer<typeof ingestionResultSchema>;

export const ingestResourcesInputSchema = z.object({
  sources: z
    .array(sourceRefSchema)
    .min(1)
    .max(10)
    .describe('Exact resource references to acquire and index.'),
});

export const ingestResourcesOutputSchema = z.object({
  results: z.array(ingestionResultSchema),
});

export type ResourceErrorCode =
  | 'INVALID_SOURCE'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_UNAVAILABLE'
  | 'EMPTY_CONTENT'
  | 'CONFIG_ERROR'
  | 'EMBEDDING_ERROR'
  | 'INDEX_UNAVAILABLE'
  | 'INDEX_INCOMPATIBLE'
  | 'INDEX_ERROR'
  | 'BLOCKED_TARGET'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'RENDER_REQUIRED'
  | 'NETWORK_ERROR';

export class ResourceAcquisitionError extends Error {
  readonly code: ResourceErrorCode;

  constructor(code: ResourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResourceAcquisitionError';
    this.code = code;
  }
}

export function parseSourceUrl(value: string): SourceRef | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.hostname === 'docs.google.com') {
    const match = url.pathname.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)/);
    if (!match) return undefined;
    const result = sourceRefSchema.safeParse({ kind: 'google-doc', id: match[1] });
    return result.success ? result.data : undefined;
  }

  if (url.hostname === 'linear.app' || url.hostname.endsWith('.linear.app')) {
    const match = url.pathname.match(/\/issue\/([^/]+)/);
    if (!match) return undefined;
    const result = sourceRefSchema.safeParse({
      kind: 'linear-issue',
      id: decodeURIComponent(match[1]),
    });
    return result.success ? result.data : undefined;
  }

  if (url.hostname === 'trello.com' || url.hostname.endsWith('.trello.com')) {
    const match = url.pathname.match(/\/c\/([^/]+)/);
    if (!match) return undefined;
    const result = sourceRefSchema.safeParse({
      kind: 'trello-card',
      id: decodeURIComponent(match[1]),
    });
    return result.success ? result.data : undefined;
  }

  if (['http:', 'https:'].includes(url.protocol)) {
    const result = sourceRefSchema.safeParse({ kind: 'web', url: url.href });
    return result.success ? result.data : undefined;
  }

  return undefined;
}

export function normalizeResourceContent(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hashResourceContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function createSourceKey(sourceType: ResourceEnvelope['sourceType'], sourceId: string): string {
  return `${sourceType}:${encodeURIComponent(sourceId)}`;
}

export function createChunkId(sourceKey: string, chunkIndex: number): string {
  return createHash('sha256').update(`${sourceKey}:${chunkIndex}`).digest('hex');
}

export function createResourceEnvelope(
  input: Omit<ResourceEnvelope, 'sourceKey' | 'contentHash' | 'content'> & { content: string },
): ResourceEnvelope {
  const content = normalizeResourceContent(input.content);
  if (!content) {
    throw new ResourceAcquisitionError('EMPTY_CONTENT', 'The acquired resource contains no text.');
  }

  return resourceEnvelopeSchema.parse({
    ...input,
    content,
    sourceKey: createSourceKey(input.sourceType, input.sourceId),
    contentHash: hashResourceContent(content),
  });
}
