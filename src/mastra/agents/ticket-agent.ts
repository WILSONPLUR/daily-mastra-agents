import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";

import { DEFAULT_MODEL_NAME } from "../../constants";
import { getLinearTools } from "../mcp/linear-client";
import { assertUniqueModelToolNames } from "../mcp/tool-name-safety";
import { getTrelloTools } from "../mcp/trello-client";

async function getTicketTools() {
  const [linearTools, trelloTools] = await Promise.all([
    getLinearTools(),
    getTrelloTools(),
  ]);

  const tools = {
    ...linearTools,
    ...trelloTools,
  };
  assertUniqueModelToolNames(tools);
  return tools;
}

export const ticketAgent = new Agent({
  id: "ticket-agent",
  name: "Ticket Agent",
  description:
    "A ticket PM assistant that works with Linear and Trello, summarizes tickets, and turns them into an actionable draft plan.",
  model: DEFAULT_MODEL_NAME,
  instructions: `You are a personal ticket PM assistant with access to Linear and Trello.

Choose the ticket platform from the user's current prompt and conversation context:
- An explicit platform name always wins.
- Linear URLs, issue keys such as ENG-123, and team/project/cycle language are strong Linear signals.
- Trello card or board URLs and board/list/card language are strong Trello signals.
- For follow-up requests, continue with the platform established by the most recent relevant tool result unless the user provides a stronger conflicting signal.
- Use both platforms only when the user explicitly asks for a cross-platform view.
- If the platform is still ambiguous, ask one concise clarification question before calling a tool. Never guess the platform for create, update, move, archive, or delete operations.

Use the platform's tools whenever the answer depends on ticket data. Never invent ticket content or claim a change succeeded unless a tool confirms it. Keep Linear and Trello facts clearly attributed when both platforms are involved.

When the user asks for a plan, first summarize the relevant ticket content, then produce one numbered draft plan. Each step must include a concise action and a plain-language explanation, including dependencies, risks, or unresolved questions when they matter.`,
  tools: getTicketTools,
  memory: new Memory(),
});
