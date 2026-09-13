import assert from 'node:assert/strict';
import test from 'node:test';

test('Mentor exposes specialists, ingestion, vector query, and static fetch lazily', async () => {
  process.env.ELASTICSEARCH_URL = 'http://127.0.0.1:9200';
  process.env.ELASTICSEARCH_INDEX_NAME = 'mentor-test';
  process.env.OPENAI_API_KEY = 'test-only-placeholder';
  const { mentorAgent } = await import('../src/mastra/agents/mentor-agent.ts');

  const [agents, workflows, tools, defaultOptions] = await Promise.all([
    mentorAgent.listAgents(),
    mentorAgent.listWorkflows(),
    mentorAgent.listTools(),
    mentorAgent.getDefaultOptions(),
  ]);

  assert.deepEqual(Object.keys(agents).sort(), ['docsAgent', 'ticketAgent']);
  assert.deepEqual(Object.keys(workflows), ['ingestResourcesWorkflow']);
  assert.deepEqual(Object.keys(tools).sort(), ['read_files', 'vectorQueryTool', 'webFetchTool']);
  assert.equal(tools.read_files.id, 'read_files');
  assert.equal(tools.webFetchTool.id, 'web_fetch');
  assert.equal(tools.vectorQueryTool.id, 'mentor-vector-query');
  assert.equal(defaultOptions.providerOptions.openai.passThroughUnsupportedFiles, true);
});
