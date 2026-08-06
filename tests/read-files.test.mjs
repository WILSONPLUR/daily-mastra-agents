import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DocumentImportError,
  resolveDocumentInput,
  validateDocumentForImport,
} from '../src/mastra/tools/read-files.ts';
import { importFileToDocsWorkflow } from '../src/mastra/workflows/import-file-to-docs.ts';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + nameBuffer.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(local, 30);
    data.copy(local, 30 + nameBuffer.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(localOffset, 42);
    nameBuffer.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function docxBuffer(extraEntries = []) {
  return createStoredZip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    ],
    ...extraEntries,
  ]);
}

function odtBuffer() {
  return createStoredZip([
    ['mimetype', 'application/vnd.oasis.opendocument.text'],
    [
      'content.xml',
      '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',
    ],
  ]);
}

const fixtures = [
  ['sample.docx', docxBuffer(), 'docx'],
  [
    'sample.doc',
    Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504),
      Buffer.from('WordDocument', 'utf16le'),
      Buffer.from('1Table', 'utf16le'),
    ]),
    'doc',
  ],
  ['sample.odt', odtBuffer(), 'odt'],
  ['sample.rtf', Buffer.from('{\\rtf1\\ansi Safe document}'), 'rtf'],
  ['sample.txt', Buffer.from('Safe UTF-8 text'), 'txt'],
  ['sample.html', Buffer.from('<!doctype html><html><body>Safe</body></html>'), 'html'],
  [
    'sample.pdf',
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF'),
    'pdf',
  ],
];

test('accepts every supported Google Docs import format', async t => {
  const root = await mkdtemp(join(tmpdir(), 'read-files-formats-'));
  process.env.DOCUMENT_UPLOAD_DIRS = root;
  t.after(async () => {
    delete process.env.DOCUMENT_UPLOAD_DIRS;
    await rm(root, { recursive: true, force: true });
  });

  for (const [name, contents, format] of fixtures) {
    const filePath = join(root, name);
    await writeFile(filePath, contents);
    const result = await validateDocumentForImport(filePath);
    assert.equal(result.format, format);
    assert.equal(result.validation.malwareScan.status, 'not_performed');
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  }
});

test('rejects extension-content mismatches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'read-files-mismatch-'));
  process.env.DOCUMENT_UPLOAD_DIRS = root;
  t.after(async () => {
    delete process.env.DOCUMENT_UPLOAD_DIRS;
    await rm(root, { recursive: true, force: true });
  });

  const filePath = join(root, 'renamed.docx');
  await writeFile(filePath, fixtures.at(-1)[1]);
  await assert.rejects(
    validateDocumentForImport(filePath),
    error => error instanceof DocumentImportError && error.code === 'SIGNATURE_MISMATCH',
  );
});

test('rejects active HTML and macro-enabled DOCX content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'read-files-active-'));
  process.env.DOCUMENT_UPLOAD_DIRS = root;
  t.after(async () => {
    delete process.env.DOCUMENT_UPLOAD_DIRS;
    await rm(root, { recursive: true, force: true });
  });

  const htmlPath = join(root, 'active.html');
  const docxPath = join(root, 'macro.docx');
  await writeFile(htmlPath, '<html><script>alert(1)</script></html>');
  await writeFile(docxPath, docxBuffer([['word/vbaProject.bin', Buffer.from('macro')]]));

  for (const filePath of [htmlPath, docxPath]) {
    await assert.rejects(
      validateDocumentForImport(filePath),
      error =>
        error instanceof DocumentImportError && error.code === 'ACTIVE_CONTENT_DETECTED',
    );
  }
});

test('rejects symlinks and files outside configured roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'read-files-root-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'read-files-outside-'));
  process.env.DOCUMENT_UPLOAD_DIRS = root;
  t.after(async () => {
    delete process.env.DOCUMENT_UPLOAD_DIRS;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  const outsidePath = join(outsideRoot, 'outside.txt');
  const linkPath = join(root, 'link.txt');
  await writeFile(outsidePath, 'outside');
  await symlink(outsidePath, linkPath);

  await assert.rejects(
    validateDocumentForImport(outsidePath),
    error =>
      error instanceof DocumentImportError && error.code === 'PATH_OUTSIDE_UPLOAD_ROOTS',
  );
  await assert.rejects(
    validateDocumentForImport(linkPath),
    error => error instanceof DocumentImportError && error.code === 'SYMLINK_NOT_ALLOWED',
  );
});

test('resolves and validates the latest inline Studio attachment', async () => {
  const pdf = fixtures.find(([name]) => name.endsWith('.pdf'));
  const result = await resolveDocumentInput({}, [
    {
      role: 'user',
      content: {
        format: 2,
        parts: [
          { type: 'text', text: 'Use this file' },
          {
            type: 'file',
            data: `data:application/pdf;base64,${pdf[1].toString('base64')}`,
            mimeType: 'application/pdf',
            filename: pdf[0],
          },
        ],
      },
    },
  ]);

  assert.equal(result.format, 'pdf');
  assert.equal(result.validation.sourceAccess, 'inline_attachment');
  assert.equal(result.validation.checks.pathContainment, 'not_applicable');
  assert.deepEqual(result.buffer, pdf[1]);
});

test('recovers a DOCX filename from MIME metadata stripped by tool execution', async () => {
  const docx = fixtures.find(([name]) => name.endsWith('.docx'));
  const result = await resolveDocumentInput({}, [
    {
      role: 'user',
      content: [
        {
          type: 'file',
          data: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${docx[1].toString('base64')}`,
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
    },
  ]);

  assert.equal(result.sourceName, 'uploaded-document.docx');
  assert.equal(result.format, 'docx');
  assert.deepEqual(result.buffer, docx[1]);
});

test('rejects ambiguous and Studio-corrupted attachment inputs', async () => {
  const pdf = fixtures.find(([name]) => name.endsWith('.pdf'));
  const filePart = name => ({
    type: 'file',
    data: `data:application/pdf;base64,${pdf[1].toString('base64')}`,
    mimeType: 'application/pdf',
    filename: name,
  });

  await assert.rejects(
    resolveDocumentInput({}, [
      { role: 'user', content: [filePart('one.pdf'), filePart('two.pdf')] },
    ]),
    error => error instanceof DocumentImportError && error.code === 'AMBIGUOUS_ATTACHMENT',
  );
  await assert.rejects(
    resolveDocumentInput({}, [
      { role: 'user', content: [{ type: 'text', text: 'PK\u0003\u0004corrupted' }] },
    ]),
    error =>
      error instanceof DocumentImportError &&
      error.code === 'STUDIO_ATTACHMENT_WAS_DECODED_AS_TEXT',
  );
});

test('import workflow fails during validation before external side effects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'import-workflow-invalid-'));
  process.env.DOCUMENT_UPLOAD_DIRS = root;
  t.after(async () => {
    delete process.env.DOCUMENT_UPLOAD_DIRS;
    await rm(root, { recursive: true, force: true });
  });

  const filePath = join(root, 'unsupported.csv');
  await writeFile(filePath, 'not a supported document');

  const run = await importFileToDocsWorkflow.createRun();
  const result = await run.start({ inputData: { filePath } });

  assert.equal(result.status, 'failed');
  assert.equal(result.steps['validate-import-source'].status, 'failed');
});
