const MODEL_TOOL_NAME_LIMIT = 64;

function resolveModelToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MODEL_TOOL_NAME_LIMIT);
}

/**
 * Fail before a model request when two registered tool keys collapse to the
 * same provider-facing name. OpenAI-compatible providers accept at most 64
 * characters and normalize unsupported punctuation.
 */
export function assertUniqueModelToolNames(tools: Record<string, unknown>): void {
  const resolvedNames = new Map<string, string>();

  for (const originalName of Object.keys(tools)) {
    const resolvedName = resolveModelToolName(originalName);
    const existingName = resolvedNames.get(resolvedName);
    if (existingName) {
      throw new Error(
        `Ticket tool names collide after provider normalization: ${existingName} and ${originalName} both resolve to ${resolvedName}.`,
      );
    }
    resolvedNames.set(resolvedName, originalName);
  }
}
