import { Composio, SessionPreset } from '@composio/core';
import { MCPClient } from '@mastra/mcp';

import { getComposioConfig } from '../../config/env';

type TrelloTools = Awaited<ReturnType<MCPClient['listTools']>>;

let trelloToolsPromise: Promise<TrelloTools> | undefined;

/**
 * Keep the direct-tool surface focused on ticket planning. Exposing Trello's
 * entire OpenAPI surface adds hundreds of irrelevant tools and produces name
 * collisions after model providers apply their tool-name length limit.
 */
export const TRELLO_TICKET_TOOL_SLUGS = [
  'TRELLO_GET_MEMBERS_ME',
  'TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER',
  'TRELLO_GET_BOARDS_BY_ID_BOARD',
  'TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD',
  'TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD',
  'TRELLO_GET_LISTS_CARDS_BY_ID_LIST',
  'TRELLO_GET_CARDS_BY_ID_CARD',
  'TRELLO_GET_SEARCH',
  'TRELLO_CREATE_ORGANIZATION',
  'TRELLO_ADD_BOARDS',
  'TRELLO_ADD_LISTS',
  'TRELLO_ADD_CARDS',
  'TRELLO_ADD_CARDS_ACTIONS_COMMENTS_BY_ID_CARD',
  'TRELLO_UPDATE_BOARDS_BY_ID_BOARD',
  'TRELLO_UPDATE_LISTS_BY_ID_LIST',
  'TRELLO_UPDATE_CARDS_BY_ID_CARD',
];

async function loadTrelloTools(): Promise<TrelloTools> {
  const { apiKey, userId } = getComposioConfig();
  const composio = new Composio({ apiKey });

  const session = await composio.sessions.create(userId, {
    toolkits: ['trello'],
    tools: {
      trello: { enable: TRELLO_TICKET_TOOL_SLUGS },
    },
    mcp: true,
    sessionPreset: SessionPreset.DIRECT_TOOLS,
    manageConnections: { enable: true },
    sandbox: { enable: false },
  });

  const mcpClient = new MCPClient({
    id: `composio-trello-${session.sessionId}`,
    servers: {
      trello: {
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
export function getTrelloTools(): Promise<TrelloTools> {
  trelloToolsPromise ??= loadTrelloTools().catch((error: unknown) => {
    trelloToolsPromise = undefined;
    throw new Error('Unable to connect the Trello tools through Composio.', {
      cause: error,
    });
  });

  return trelloToolsPromise;
}
