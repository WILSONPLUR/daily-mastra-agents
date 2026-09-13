import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { ElasticSearchVector } from '@mastra/elasticsearch';
import { createVectorQueryTool } from '@mastra/rag';

import { getElasticsearchConfig } from '../../config/env';

export const EMBEDDING_DIMENSION = 1536;
export const EMBEDDING_MODEL_NAME = 'openai/text-embedding-3-small';

let vectorStore: ElasticSearchVector | undefined;

export function getMentorVectorStore(): ElasticSearchVector {
  if (vectorStore) return vectorStore;

  const config = getElasticsearchConfig();
  vectorStore = new ElasticSearchVector({
    id: 'mentor-elasticsearch-vector',
    url: config.url,
    ...(config.apiKey ? { auth: { apiKey: config.apiKey } } : {}),
  });
  return vectorStore;
}

export function createMentorEmbeddingModel(): ModelRouterEmbeddingModel {
  return new ModelRouterEmbeddingModel(EMBEDDING_MODEL_NAME);
}

export function createMentorVectorQueryTool() {
  const { indexName } = getElasticsearchConfig();
  return createVectorQueryTool({
    id: 'mentor-vector-query',
    description:
      'Search only the Mentor knowledge base and return relevant source chunks with citation metadata.',
    vectorStore: () => getMentorVectorStore(),
    indexName,
    model: createMentorEmbeddingModel(),
    includeSources: true,
  });
}
