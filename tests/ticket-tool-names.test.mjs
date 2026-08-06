import assert from 'node:assert/strict';
import test from 'node:test';

import { LINEAR_TICKET_TOOL_SLUGS } from '../src/mastra/mcp/linear-client.ts';
import { TRELLO_TICKET_TOOL_SLUGS } from '../src/mastra/mcp/trello-client.ts';
import { assertUniqueModelToolNames } from '../src/mastra/mcp/tool-name-safety.ts';

test('selected Linear and Trello tools have unique provider-facing names', () => {
  const tools = Object.fromEntries([
    ...LINEAR_TICKET_TOOL_SLUGS.map(slug => [`linear_${slug}`, {}]),
    ...TRELLO_TICKET_TOOL_SLUGS.map(slug => [`trello_${slug}`, {}]),
  ]);

  assert.doesNotThrow(() => assertUniqueModelToolNames(tools));
});

test('detects the Trello notification collision before a model request', () => {
  const tools = {
    trello_TRELLO_GET_NOTIFICATIONS_MEMBER_CREATOR_BY_ID_NOTIFICATION: {},
    trello_TRELLO_GET_NOTIFICATIONS_MEMBER_CREATOR_BY_ID_NOTIFICATION_B: {},
  };

  assert.throws(
    () => assertUniqueModelToolNames(tools),
    /Ticket tool names collide after provider normalization/,
  );
});
