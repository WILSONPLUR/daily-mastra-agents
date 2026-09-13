import { Composio, SessionPreset } from '@composio/core';
import { MCPClient } from '@mastra/mcp';

import { getComposioConfig, getComposioToolkitVersion } from '../../config/env';
import { executeSessionTool } from '../tools/session-execute';

type GoogleDocsTools = Awaited<ReturnType<MCPClient['listTools']>>;
type GoogleDocsIntegration = {
  tools: GoogleDocsTools;
  execute: (
    toolSlug: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
};

let googleDocsIntegrationPromise: Promise<GoogleDocsIntegration> | undefined;

async function loadGoogleDocsIntegration(): Promise<GoogleDocsIntegration> {
  const { apiKey, userId } = getComposioConfig();
  const composio = new Composio({
    apiKey,
    toolkitVersions: { googledocs: getComposioToolkitVersion('googledocs') },
  });

  const session = await composio.sessions.create(userId, {
    toolkits: ['googledocs'],
    mcp: true,
    // Expose the Google Docs tools themselves instead of routing every call
    // through COMPOSIO_MULTI_EXECUTE_TOOL. This also lets us keep the remote
    // workbench disabled without its sync_response_to_workbench schema field.
    sessionPreset: SessionPreset.DIRECT_TOOLS,
    manageConnections: { enable: true },
    sandbox: { enable: false },
  });

  const mcpClient = new MCPClient({
    id: `composio-google-docs-${session.sessionId}`,
    servers: {
      googleDocs: {
        url: new URL(session.mcp.url),
        requestInit: {
          headers: session.mcp.headers,
        },
      },
    },
    timeout: 30_000,
  });

  try {
    const tools = await mcpClient.listTools();
    return {
      tools,
      execute: async (toolSlug, args, signal) => {
        const result = await executeSessionTool(session, toolSlug, args, signal);
        if (result.error) throw new Error(result.error);
        return result.data;
      },
    };
  } catch (error) {
    await mcpClient.disconnect();
    throw error;
  }
}

/**
 * Lazily creates one Composio session for this single-user process.
 * Failed initialization is not cached, so the next agent run can retry.
 */
export function getGoogleDocsTools(): Promise<GoogleDocsTools> {
  return getGoogleDocsIntegration().then(integration => integration.tools);
}

export function executeGoogleDocsTool(
  toolSlug: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return getGoogleDocsIntegration().then(integration =>
    integration.execute(toolSlug, args, signal),
  );
}

function getGoogleDocsIntegration(): Promise<GoogleDocsIntegration> {
  googleDocsIntegrationPromise ??= loadGoogleDocsIntegration().catch((error: unknown) => {
    googleDocsIntegrationPromise = undefined;
    throw new Error('Unable to connect the Google Docs tools through Composio.', {
      cause: error,
    });
  });

  return googleDocsIntegrationPromise;
}
