import type { ElasticSearchVector } from '@mastra/elasticsearch';
import { MDocument } from '@mastra/rag';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { embedMany } from 'ai';

import { getElasticsearchConfig } from '../../config/env';
import {
  createChunkId,
  ingestResourcesInputSchema,
  ingestResourcesOutputSchema,
  ResourceAcquisitionError,
  type IngestionResult,
  type ResourceEnvelope,
  type SourceRef,
} from '../resources/contracts';
import { acquireResource } from '../resources/source-adapters';
import {
  createMentorEmbeddingModel,
  EMBEDDING_DIMENSION,
  getMentorVectorStore,
} from '../resources/vector-store';

type IngestionVectorStore = Pick<
  ElasticSearchVector,
  'createIndex' | 'deleteVectors' | 'upsert'
>;

export type IngestionDependencies = {
  acquire: (source: SourceRef, signal?: AbortSignal) => Promise<ResourceEnvelope>;
  embed: (values: string[], signal?: AbortSignal) => Promise<number[][]>;
  getVectorStore: () => IngestionVectorStore;
  getIndexName: () => string;
};

const defaultDependencies: IngestionDependencies = {
  acquire: (source, signal) => acquireResource(source, { signal }),
  embed: async (values, signal) => {
    const result = await embedMany({
      model: createMentorEmbeddingModel(),
      values,
      abortSignal: signal,
    });
    return result.embeddings;
  },
  getVectorStore: getMentorVectorStore,
  getIndexName: () => getElasticsearchConfig().indexName,
};

function chunkMetadata(envelope: ResourceEnvelope, text: string, chunkIndex: number) {
  return {
    ...envelope.metadata,
    text,
    title: envelope.title,
    canonicalUrl: envelope.canonicalUrl,
    sourceKey: envelope.sourceKey,
    sourceType: envelope.sourceType,
    sourceId: envelope.sourceId,
    revision: envelope.revision ?? '',
    contentHash: envelope.contentHash,
    retrievedAt: envelope.retrievedAt,
    chunkIndex,
  };
}

type IngestionStage = 'acquire' | 'chunk' | 'index' | 'embed' | 'replace';

function errorFingerprint(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      for (const key of ['name', 'message', 'code']) {
        if (typeof record[key] === 'string') parts.push(record[key]);
      }
      current = record.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts.join(' ').toLowerCase();
}

function classifyIngestionError(error: unknown, stage: IngestionStage) {
  if (error instanceof ResourceAcquisitionError) {
    return { errorCode: error.code, message: error.message };
  }

  const fingerprint = errorFingerprint(error);
  if (stage === 'index' || stage === 'replace') {
    if (/required/.test(fingerprint) && /elasticsearch/.test(fingerprint)) {
      return {
        errorCode: 'CONFIG_ERROR',
        message:
          'The source was acquired, but Elasticsearch configuration is incomplete. Set ELASTICSEARCH_URL and ELASTICSEARCH_INDEX_NAME.',
      };
    }
    if (/connectionerror|econnrefused|enotfound|socket|connect timeout/.test(fingerprint)) {
      return {
        errorCode: 'INDEX_UNAVAILABLE',
        message:
          'The source was acquired, but Elasticsearch is unavailable. Start the configured node and retry ingestion.',
      };
    }
    if (/dimension|mapping|incompatible/.test(fingerprint)) {
      return {
        errorCode: 'INDEX_INCOMPATIBLE',
        message:
          'The existing Elasticsearch index is incompatible with 1,536-dimension Mentor embeddings and was left untouched.',
      };
    }
    return {
      errorCode: 'INDEX_ERROR',
      message: 'The source was acquired, but Elasticsearch could not replace its vectors.',
    };
  }

  if (stage === 'embed') {
    return {
      errorCode: 'EMBEDDING_ERROR',
      message: 'The source was acquired, but its embeddings could not be generated.',
    };
  }

  return {
    errorCode: 'INDEX_ERROR',
    message: 'The acquired source could not be prepared for indexing.',
  };
}

export async function ingestOneResource(
  source: SourceRef,
  options: {
    signal?: AbortSignal;
    dependencies?: Partial<IngestionDependencies>;
  } = {},
): Promise<IngestionResult> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  let envelope: ResourceEnvelope | undefined;
  let stage: IngestionStage = 'acquire';

  try {
    envelope = await dependencies.acquire(source, options.signal);
    stage = 'chunk';
    const chunks = await MDocument.fromText(envelope.content).chunk({
      strategy: 'recursive',
      maxSize: 4_000,
      overlap: 400,
    });
    const texts = chunks.map(chunk => chunk.text).filter(Boolean);
    if (!texts.length) {
      throw new ResourceAcquisitionError('EMPTY_CONTENT', 'Chunking produced no readable text.');
    }

    // Validate storage before paying for embeddings, but never replace old vectors
    // until the complete new embedding set is available.
    stage = 'index';
    const vectorStore = dependencies.getVectorStore();
    const indexName = dependencies.getIndexName();
    await vectorStore.createIndex({
      indexName,
      dimension: EMBEDDING_DIMENSION,
      metric: 'cosine',
    });

    stage = 'embed';
    const embeddings = await dependencies.embed(texts, options.signal);
    if (
      embeddings.length !== texts.length ||
      embeddings.some(embedding => embedding.length !== EMBEDDING_DIMENSION)
    ) {
      throw new Error('The embedding provider returned an unexpected vector shape.');
    }

    const ids = texts.map((_text, chunkIndex) =>
      createChunkId(envelope!.sourceKey, chunkIndex),
    );
    const metadata = texts.map((text, chunkIndex) =>
      chunkMetadata(envelope!, text, chunkIndex),
    );

    stage = 'replace';
    await vectorStore.deleteVectors({
      indexName,
      filter: { sourceKey: envelope.sourceKey },
    });
    await vectorStore.upsert({
      indexName,
      vectors: embeddings,
      metadata,
      ids,
    });

    return {
      source,
      status: 'indexed',
      sourceKey: envelope.sourceKey,
      canonicalUrl: envelope.canonicalUrl,
      contentHash: envelope.contentHash,
      chunkCount: texts.length,
    };
  } catch (error) {
    const failure = classifyIngestionError(error, stage);
    return {
      source,
      status: 'failed',
      ...(envelope?.sourceKey ? { sourceKey: envelope.sourceKey } : {}),
      ...(envelope?.canonicalUrl ? { canonicalUrl: envelope.canonicalUrl } : {}),
      ...(envelope?.contentHash ? { contentHash: envelope.contentHash } : {}),
      errorCode: failure.errorCode,
      message: failure.message,
    };
  }
}

export async function ingestResourceBatch(
  sources: SourceRef[],
  options: {
    signal?: AbortSignal;
    dependencies?: Partial<IngestionDependencies>;
  } = {},
): Promise<IngestionResult[]> {
  const results: IngestionResult[] = [];
  for (const source of sources) {
    results.push(await ingestOneResource(source, options));
  }
  return results;
}

const ingestResourcesStep = createStep({
  id: 'acquire-normalize-and-index-resources',
  description:
    'Read exact resource references through deterministic adapters, then chunk, embed, and replace their indexed vectors.',
  inputSchema: ingestResourcesInputSchema,
  outputSchema: ingestResourcesOutputSchema,
  execute: async ({ inputData, abortSignal, mastra }) => {
    const results = await ingestResourceBatch(inputData.sources, { signal: abortSignal });
    for (const result of results) {
      mastra.getLogger().info('Mentor resource ingestion completed.', {
        sourceType: result.source.kind,
        outcome: result.status === 'indexed' ? 'indexed' : result.errorCode,
        chunkCount: result.chunkCount ?? 0,
      });
    }
    return { results };
  },
});

export const ingestResourcesWorkflow = createWorkflow({
  id: 'ingest-resources',
  description:
    'Persist 1–10 exact Google Docs, Linear issues, Trello cards, or public static web pages in the Mentor knowledge base. Returns one validated receipt per source; failures are isolated.',
  inputSchema: ingestResourcesInputSchema,
  outputSchema: ingestResourcesOutputSchema,
})
  .then(ingestResourcesStep)
  .commit();
