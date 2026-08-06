import { Composio, SessionPreset } from '@composio/core';
import { MCPClient } from '@mastra/mcp';

import { getComposioConfig } from '../../config/env';

type GoogleDocsTools = Awaited<ReturnType<MCPClient['listTools']>>;

let googleDocsToolsPromise: Promise<GoogleDocsTools> | undefined;

async function loadGoogleDocsTools(): Promise<GoogleDocsTools> {
  const { apiKey, userId } = getComposioConfig();
  const composio = new Composio({ apiKey });

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
    return await mcpClient.listTools();
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
  googleDocsToolsPromise ??= loadGoogleDocsTools().catch((error: unknown) => {
    googleDocsToolsPromise = undefined;
    throw new Error('Unable to connect the Google Docs tools through Composio.', {
      cause: error,
    });
  });

  return googleDocsToolsPromise;
}
