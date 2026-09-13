import type { ToolRouterSessionExecuteResponse } from '@composio/core';

type PublicSession = {
  execute: (
    toolSlug: string,
    args?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<ToolRouterSessionExecuteResponse>;
};

/**
 * Composio 0.13.1 implements a fourth per-request options argument on the
 * concrete session class, while its public Session interface omits it. Keep
 * the compatibility cast isolated here so adapter reads still propagate aborts.
 */
export function executeSessionTool(
  session: PublicSession,
  toolSlug: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolRouterSessionExecuteResponse> {
  const execute = session.execute as unknown as (
    toolSlug: string,
    args?: Record<string, unknown>,
    options?: Record<string, unknown>,
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<ToolRouterSessionExecuteResponse>;

  return execute.call(session, toolSlug, args, undefined, { signal });
}
