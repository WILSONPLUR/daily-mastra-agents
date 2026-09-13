export type ComposioConfig = {
  apiKey: string;
  userId: string;
};

export type ElasticsearchConfig = {
  url: string;
  indexName: string;
  apiKey?: string;
};

const COMPOSIO_TOOLKIT_VERSION_DEFAULTS = {
  googledocs: '20260721_00',
  linear: '20260804_00',
  trello: '20260812_00',
} as const;

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

export function getComposioConfig(): ComposioConfig {
  return {
    apiKey: requireEnvironmentVariable('COMPOSIO_API_KEY'),
    userId: requireEnvironmentVariable('COMPOSIO_USER_ID'),
  };
}

export function getComposioToolkitVersion(
  toolkit: keyof typeof COMPOSIO_TOOLKIT_VERSION_DEFAULTS,
): string {
  return (
    process.env[`COMPOSIO_TOOLKIT_VERSION_${toolkit.toUpperCase()}`]?.trim() ||
    COMPOSIO_TOOLKIT_VERSION_DEFAULTS[toolkit]
  );
}

export function getElasticsearchConfig(): ElasticsearchConfig {
  const apiKey = process.env.ELASTICSEARCH_API_KEY?.trim();

  return {
    url: requireEnvironmentVariable('ELASTICSEARCH_URL'),
    indexName: process.env.ELASTICSEARCH_INDEX_NAME?.trim() || 'mentor-resources',
    ...(apiKey ? { apiKey } : {}),
  };
}
