import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
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
import { ticketAgent } from "./agents/ticket-agent"
import { startScheduleTool, stopScheduleTool } from './tools/schedule-tools';
import { webFetchTool } from './tools/web-fetch-tool';
import { readFiles } from './tools/read-files';
import { importFileToDocsWorkflow } from './workflows/import-file-to-docs';

export const mastra = new Mastra({
  agents: { agent, docsAgent, ticketAgent },
  tools: { startScheduleTool, stopScheduleTool, webFetchTool, readFiles },
  workflows: { importFileToDocsWorkflow },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
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
