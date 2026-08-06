import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { readFiles, readFilesOutputSchema, validateDocumentForImport } from '../tools/read-files';

export const importFileToDocsInputSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe('Path to a document inside one of the approved server-side upload directories.'),
  declaredMimeType: z
    .string()
    .optional()
    .describe('MIME type supplied by the upload transport, when available.'),
  title: z.string().max(200).optional().describe('Optional title for the new Google Doc.'),
  folderId: z.string().min(1).optional().describe('Optional destination Google Drive folder ID.'),
});

const preparedImportSchema = importFileToDocsInputSchema.extend({
  filePath: z.string().min(1).describe('Canonical path verified by the validation step.'),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe('Fingerprint that the import step must observe before uploading.'),
  source: z.object({
    name: z.string(),
    format: z.enum(['docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'pdf']),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  }),
});

const validateImportSource = createStep({
  id: 'validate-import-source',
  description:
    'Resolve the approved local path, validate the document structure, and fingerprint its bytes before any external side effect.',
  inputSchema: importFileToDocsInputSchema,
  outputSchema: preparedImportSchema,
  execute: async ({ inputData }) => {
    const document = await validateDocumentForImport(
      inputData.filePath,
      inputData.declaredMimeType,
    );
    if (!document.canonicalPath) {
      throw new Error('Validated local documents must have a canonical path.');
    }

    return {
      ...inputData,
      filePath: document.canonicalPath,
      expectedSha256: document.sha256,
      source: {
        name: document.sourceName,
        format: document.format,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
      },
    };
  },
});

const importValidatedDocument = createStep(readFiles);

export const importFileToDocsWorkflow = createWorkflow({
  id: 'import-file-to-docs',
  description:
    'Validate an approved local document, import it as a native Google Doc, verify conversion, and clean up the source upload.',
  inputSchema: importFileToDocsInputSchema,
  outputSchema: readFilesOutputSchema,
})
  .then(validateImportSource)
  .map(async ({ inputData }) => ({
    filePath: inputData.filePath,
    declaredMimeType: inputData.declaredMimeType,
    title: inputData.title,
    folderId: inputData.folderId,
    expectedSha256: inputData.expectedSha256,
  }))
  // The import creates external resources, so it is intentionally not retried automatically.
  .then(importValidatedDocument)
  .commit();
