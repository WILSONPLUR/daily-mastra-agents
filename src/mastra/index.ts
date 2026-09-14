import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { PostgresStore } from '@mastra/pg';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { agent } from './agents/agent';
import { docsAgent } from './agents/docs-agent';
import { mentorAgent } from './agents/mentor-agent';
import { ticketAgent } from './agents/ticket-agent';
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';
import { webFetchTool } from './tools/web-fetch-tool';
import { readFiles } from './tools/read-files';
import { importFileToDocsWorkflow } from './workflows/import-file-to-docs';
import { ingestResourcesWorkflow } from './workflows/ingest-resources';

// Keep the fallback directly guarded by DATABASE_URL for deployment preflight.
const storageUrl =
  process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL || 'file:./mastra.db';

export const mastra = new Mastra({
  agents: { agent, docsAgent, ticketAgent, mentorAgent },
  tools: { startScheduleTool, stopScheduleTool, webFetchTool, readFiles },
  workflows: { importFileToDocsWorkflow, ingestResourcesWorkflow },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: process.env.DATABASE_URL
      ? new PostgresStore({
          id: 'mastra-storage',
          connectionString: storageUrl,
        })
      : new LibSQLStore({
          id: 'mastra-storage',
          url: storageUrl,
          authToken: process.env.TURSO_AUTH_TOKEN || undefined,
        }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
