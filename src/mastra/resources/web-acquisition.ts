import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Readability } from '@mozilla/readability';
import ipaddr from 'ipaddr.js';
import { JSDOM } from 'jsdom';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARACTERS = 200_000;
const DEFAULT_MAX_REDIRECTS = 5;
const STATIC_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const SUPPORTED_TEXT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml',
]);

export type PageAcquisitionErrorCode =
  | 'BLOCKED_TARGET'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'EMPTY_CONTENT'
  | 'RENDER_REQUIRED'
  | 'NETWORK_ERROR';

export type PageAcquisitionSuccess = {
  ok: true;
  requestedUrl: string;
  url: string;
  canonicalUrl?: string;
  title?: string;
  status: number;
  statusText: string;
  contentType: string | null;
  text: string;
  extractor: 'readability' | 'body-text' | 'plain';
  bytes: number;
  truncated: boolean;
  warnings: string[];
};

export type PageAcquisitionFailure = {
  ok: false;
  requestedUrl: string;
  url?: string;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  code: PageAcquisitionErrorCode;
  message: string;
};

export type PageAcquisitionResult = PageAcquisitionSuccess | PageAcquisitionFailure;

type ExtractedPage = Pick<PageAcquisitionSuccess, 'text' | 'extractor'> &
  Partial<Pick<PageAcquisitionSuccess, 'canonicalUrl' | 'title'>>;

type ResolvedAddress = { address: string; family: 4 | 6 };

type FetchLike = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export type AcquirePageOptions = {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxTextCharacters?: number;
  maxRedirects?: number;
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  fetch?: FetchLike;
};

class PageAcquisitionError extends Error {
  readonly code: PageAcquisitionErrorCode;

  constructor(code: PageAcquisitionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PageAcquisitionError';
    this.code = code;
  }
}

function isBenchmarkingAddress(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (address.kind() !== 'ipv4') return false;
  return address.match(ipaddr.parseCIDR('198.18.0.0/15'));
}

export function isPublicIpAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return false;

  let address = ipaddr.parse(value);
  if (address.kind() === 'ipv6') {
    const ipv6Address = address as ipaddr.IPv6;
    if (ipv6Address.isIPv4MappedAddress()) {
      address = ipv6Address.toIPv4Address();
    }
  }

  return address.range() === 'unicast' && !isBenchmarkingAddress(address);
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses
    .filter(result => result.family === 4 || result.family === 6)
    .map(result => ({ address: result.address, family: result.family as 4 | 6 }));
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function resolvePublicAddress(
  hostname: string,
  lookup: NonNullable<AcquirePageOptions['lookup']>,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  const normalizedHostname =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const literalFamily = isIP(normalizedHostname);
  const addresses = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily as 4 | 6 }]
    : await withAbort(lookup(normalizedHostname), signal);

  if (addresses.length === 0) {
    throw new PageAcquisitionError('NETWORK_ERROR', 'The hostname did not resolve.');
  }

  if (addresses.some(result => !isPublicIpAddress(result.address))) {
    throw new PageAcquisitionError(
      'BLOCKED_TARGET',
      'The URL resolves to a non-public network address.',
    );
  }

  return addresses[0];
}

function createPinnedDispatcher(address: ResolvedAddress): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          const allCallback = callback as unknown as (
            error: NodeJS.ErrnoException | null,
            addresses: ResolvedAddress[],
          ) => void;
          allCallback(null, [address]);
          return;
        }
        const singleCallback = callback as unknown as (
          error: NodeJS.ErrnoException | null,
          resolvedAddress: string,
          family: number,
        ) => void;
        singleCallback(null, address.address, address.family);
      },
    },
  });
}

function validateUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new PageAcquisitionError('BLOCKED_TARGET', 'The URL is invalid.', { cause: error });
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new PageAcquisitionError('BLOCKED_TARGET', 'Only HTTP and HTTPS URLs are supported.');
  }
  if (url.username || url.password) {
    throw new PageAcquisitionError('BLOCKED_TARGET', 'URLs containing credentials are not supported.');
  }

  return url;
}

function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
}

function charset(contentType: string | null): string {
  return contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? 'utf-8';
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new PageAcquisitionError(
      'TOO_LARGE',
      `The response exceeds the ${maxBodyBytes}-byte limit.`,
    );
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        throw new PageAcquisitionError(
          'TOO_LARGE',
          `The response exceeds the ${maxBodyBytes}-byte limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeBody(body: Uint8Array, contentType: string | null, warnings: string[]): string {
  const declaredCharset = charset(contentType);
  try {
    return new TextDecoder(declaredCharset).decode(body);
  } catch {
    warnings.push(`Unsupported charset ${declaredCharset}; decoded as UTF-8.`);
    return new TextDecoder('utf-8').decode(body);
  }
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveCanonicalUrl(
  document: Document,
  finalUrl: string,
  warnings: string[],
): string | undefined {
  const href = document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href;
  if (!href) return undefined;
  try {
    const canonical = new URL(href, finalUrl);
    const final = new URL(finalUrl);
    if (!['http:', 'https:'].includes(canonical.protocol) || canonical.origin !== final.origin) {
      warnings.push('Ignored a cross-origin or unsupported canonical URL.');
      return undefined;
    }
    return canonical.href;
  } catch {
    return undefined;
  }
}

function extractHtml(
  html: string,
  finalUrl: string,
  warnings: string[],
): ExtractedPage {
  const dom = new JSDOM(html, { url: finalUrl, runScripts: 'outside-only' });
  const document = dom.window.document;
  const canonicalUrl = resolveCanonicalUrl(document, finalUrl, warnings);
  const pageTitle = normalizeExtractedText(document.title);
  const hasAppShell = Boolean(
    document.querySelector('#root, #app, [data-reactroot], [data-react-root]'),
  );
  const scriptCount = document.scripts.length;

  document
    .querySelectorAll('script, style, noscript, template, svg, nav, footer, header, aside, form')
    .forEach(element => element.remove());

  const parsed = new Readability(document.cloneNode(true) as Document).parse();
  const readableText = normalizeExtractedText(parsed?.textContent ?? '');
  if (readableText.length >= 120) {
    return {
      canonicalUrl,
      title: normalizeExtractedText(parsed?.title ?? '') || pageTitle || undefined,
      text: readableText,
      extractor: 'readability',
    };
  }

  const bodyText = normalizeExtractedText(document.body?.textContent ?? '');
  if (bodyText.length >= 120 || (bodyText && !hasAppShell && scriptCount === 0)) {
    warnings.push('Readability extraction was thin; used normalized body text.');
    return {
      canonicalUrl,
      title: pageTitle || undefined,
      text: bodyText,
      extractor: 'body-text',
    };
  }

  if (hasAppShell || scriptCount > 0) {
    throw new PageAcquisitionError(
      'RENDER_REQUIRED',
      'The page appears to require JavaScript rendering.',
    );
  }
  throw new PageAcquisitionError('EMPTY_CONTENT', 'The page contains no readable text.');
}

function extractPlainText(
  value: string,
  type: string,
  warnings: string[],
): ExtractedPage {
  if (type === 'application/json' || type === 'application/ld+json') {
    try {
      return { text: JSON.stringify(JSON.parse(value), null, 2), extractor: 'plain' };
    } catch {
      warnings.push('The response declared JSON but could not be parsed; retained decoded text.');
    }
  }
  return { text: normalizeExtractedText(value), extractor: 'plain' };
}

function failureFromError(
  requestedUrl: string,
  currentUrl: string | undefined,
  error: unknown,
): PageAcquisitionFailure {
  if (error instanceof PageAcquisitionError) {
    return {
      ok: false,
      requestedUrl,
      ...(currentUrl ? { url: currentUrl } : {}),
      code: error.code,
      message: error.message,
    };
  }

  if (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
  ) {
    return {
      ok: false,
      requestedUrl,
      ...(currentUrl ? { url: currentUrl } : {}),
      code: 'TIMEOUT',
      message: 'Page acquisition was aborted or timed out.',
    };
  }

  return {
    ok: false,
    requestedUrl,
    ...(currentUrl ? { url: currentUrl } : {}),
    code: 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : 'Page acquisition failed.',
  };
}

export async function acquirePage(
  requestedUrl: string,
  options: AcquirePageOptions = {},
): Promise<PageAcquisitionResult> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutSignal])
    : timeoutSignal;
  const lookup = options.lookup ?? defaultLookup;
  const fetchPage = options.fetch ?? (undiciFetch as unknown as FetchLike);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxTextCharacters = options.maxTextCharacters ?? DEFAULT_MAX_TEXT_CHARACTERS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl: URL | undefined;

  try {
    currentUrl = validateUrl(requestedUrl);

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const address = await resolvePublicAddress(currentUrl.hostname, lookup, signal);
      const dispatcher = createPinnedDispatcher(address);
      try {
        const response = await fetchPage(currentUrl, {
          dispatcher,
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': STATIC_BROWSER_USER_AGENT,
            accept:
              'text/html,text/plain,text/markdown,application/json,application/xml,text/xml;q=0.9,*/*;q=0.1',
            'accept-language': 'en-US,en;q=0.9',
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) {
            throw new PageAcquisitionError('HTTP_ERROR', 'The redirect has no Location header.');
          }
          if (redirectCount === maxRedirects) {
            throw new PageAcquisitionError('HTTP_ERROR', 'The page exceeded the redirect limit.');
          }
          currentUrl = validateUrl(new URL(location, currentUrl));
          continue;
        }

        const contentType = response.headers.get('content-type');
        if (!response.ok) {
          await response.body?.cancel();
          return {
            ok: false,
            requestedUrl,
            url: currentUrl.href,
            status: response.status,
            statusText: response.statusText,
            contentType,
            code: 'HTTP_ERROR',
            message: `The page returned HTTP ${response.status}.`,
          };
        }

        const type = mediaType(contentType);
        if (!SUPPORTED_TEXT_TYPES.has(type)) {
          await response.body?.cancel();
          return {
            ok: false,
            requestedUrl,
            url: currentUrl.href,
            status: response.status,
            statusText: response.statusText,
            contentType,
            code: 'UNSUPPORTED_CONTENT_TYPE',
            message: `Unsupported content type: ${type || 'unknown'}.`,
          };
        }

        const body = await readBoundedBody(response, maxBodyBytes);
        const warnings: string[] = [];
        const decoded = decodeBody(body, contentType, warnings);
        const extracted =
          type === 'text/html' || type === 'application/xhtml+xml'
            ? extractHtml(decoded, currentUrl.href, warnings)
            : extractPlainText(decoded, type, warnings);
        if (!extracted.text) {
          throw new PageAcquisitionError('EMPTY_CONTENT', 'The page contains no readable text.');
        }

        const truncated = extracted.text.length > maxTextCharacters;
        const text = extracted.text.slice(0, maxTextCharacters);
        if (truncated) warnings.push(`Extracted text was truncated to ${maxTextCharacters} characters.`);

        return {
          ok: true,
          requestedUrl,
          url: currentUrl.href,
          status: response.status,
          statusText: response.statusText,
          contentType,
          text,
          extractor: extracted.extractor,
          bytes: body.byteLength,
          truncated,
          warnings,
          ...(extracted.canonicalUrl ? { canonicalUrl: extracted.canonicalUrl } : {}),
          ...(extracted.title ? { title: extracted.title } : {}),
        };
      } finally {
        await dispatcher.close();
      }
    }

    throw new PageAcquisitionError('HTTP_ERROR', 'The page exceeded the redirect limit.');
  } catch (error) {
    return failureFromError(requestedUrl, currentUrl?.href, error);
  }
}
