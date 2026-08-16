import { Composio, SessionPreset } from '@composio/core';
import { MCPClient } from '@mastra/mcp';

import { getComposioConfig, getComposioToolkitVersion } from '../../config/env';
import { executeSessionTool } from './session-execute';

type LinearTools = Awaited<ReturnType<MCPClient['listTools']>>;
type LinearIntegration = {
  tools: LinearTools;
  execute: (
    toolSlug: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
};

let linearIntegrationPromise: Promise<LinearIntegration> | undefined;

export const LINEAR_TICKET_TOOL_SLUGS = [
  'LINEAR_GET_CURRENT_USER',
  'LINEAR_LIST_LINEAR_TEAMS',
  'LINEAR_LIST_LINEAR_USERS',
  'LINEAR_LIST_LINEAR_PROJECTS',
  'LINEAR_GET_LINEAR_PROJECT',
  'LINEAR_CREATE_LINEAR_PROJECT',
  'LINEAR_UPDATE_LINEAR_PROJECT',
  'LINEAR_LIST_LINEAR_STATES',
  'LINEAR_LIST_LINEAR_LABELS',
  'LINEAR_LIST_LINEAR_ISSUES',
  'LINEAR_SEARCH_ISSUES',
  'LINEAR_GET_LINEAR_ISSUE',
  'LINEAR_CREATE_LINEAR_ISSUE',
  'LINEAR_UPDATE_ISSUE',
  'LINEAR_ARCHIVE_ISSUE',
  'LINEAR_LIST_COMMENTS',
  'LINEAR_CREATE_LINEAR_COMMENT',
];

async function loadLinearIntegration(): Promise<LinearIntegration> {
  const { apiKey, userId } = getComposioConfig();
  const composio = new Composio({
    apiKey,
    toolkitVersions: { linear: getComposioToolkitVersion('linear') },
  });

  const session = await composio.sessions.create(userId, {
    toolkits: ['linear'],
    tools: {
      linear: { enable: LINEAR_TICKET_TOOL_SLUGS },
    },
    mcp: true,
    sessionPreset: SessionPreset.DIRECT_TOOLS,
    manageConnections: { enable: true },
    sandbox: { enable: false },
  });

  const mcpClient = new MCPClient({
    id: `composio-linear-${session.sessionId}`,
    servers: {
      linear: {
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
export function getLinearTools(): Promise<LinearTools> {
  return getLinearIntegration().then(integration => integration.tools);
}

export function executeLinearTool(
  toolSlug: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return getLinearIntegration().then(integration => integration.execute(toolSlug, args, signal));
}

function getLinearIntegration(): Promise<LinearIntegration> {
  linearIntegrationPromise ??= loadLinearIntegration().catch((error: unknown) => {
    linearIntegrationPromise = undefined;
    throw new Error('Unable to connect the Linear tools through Composio.', {
      cause: error,
    });
  });

  return linearIntegrationPromise;
}
