export type ComposioConfig = {
  apiKey: string;
  userId: string;
};

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required to use the Composio integrations.`);
  }

  return value;
}

export function getComposioConfig(): ComposioConfig {
  return {
    apiKey: requireEnvironmentVariable('COMPOSIO_API_KEY'),
    userId: requireEnvironmentVariable('COMPOSIO_USER_ID'),
  };
}
