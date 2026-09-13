import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { acquirePage } from '../resources/web-acquisition';

const httpUrlSchema = z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), {
  message: 'Only HTTP and HTTPS URLs are supported.',
});

const successSchema = z.object({
  ok: z.literal(true),
  requestedUrl: z.string(),
  url: z.string(),
  canonicalUrl: z.string().optional(),
  title: z.string().optional(),
  status: z.number(),
  statusText: z.string(),
  contentType: z.string().nullable(),
  text: z.string(),
  extractor: z.enum(['readability', 'body-text', 'plain']),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});

const failureSchema = z.object({
  ok: z.literal(false),
  requestedUrl: z.string(),
  url: z.string().optional(),
  status: z.number().optional(),
  statusText: z.string().optional(),
  contentType: z.string().nullable().optional(),
  code: z.enum([
    'BLOCKED_TARGET',
    'TIMEOUT',
    'HTTP_ERROR',
    'TOO_LARGE',
    'UNSUPPORTED_CONTENT_TYPE',
    'EMPTY_CONTENT',
    'RENDER_REQUIRED',
    'NETWORK_ERROR',
  ]),
  message: z.string(),
});

export const webFetchOutputSchema = z.discriminatedUnion('ok', [successSchema, failureSchema]);

export const webFetchTool = createTool({
  id: 'web_fetch',
  description:
    'Fetch and extract readable text from a public static HTTP(S) page. Returns structured failures for blocked, binary, oversized, or JavaScript-only pages.',
  inputSchema: z.object({
    url: httpUrlSchema.describe('The fully qualified public HTTP(S) URL to fetch.'),
  }),
  outputSchema: webFetchOutputSchema,
  execute: async ({ url }, { abortSignal, observe }) => {
    const run = async () => {
      const result = await acquirePage(url, { abortSignal });
      observe?.log('info', 'Static page acquisition completed.', {
        outcome: result.ok ? 'success' : result.code,
        ...(result.ok
          ? { bytes: result.bytes, extractor: result.extractor, truncated: result.truncated }
          : {}),
      });
      return result;
    };

    return observe?.span
      ? observe.span('web.acquire-page', run, { sourceType: 'web' })
      : run();
  },
});
