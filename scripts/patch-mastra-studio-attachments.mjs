import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const assetDirectory = join(process.cwd(), 'node_modules', 'mastra', 'dist', 'studio', 'assets');
const assetName = (await readdir(assetDirectory)).find(name => /^main-.*\.js$/.test(name));
if (!assetName) {
  throw new Error('Could not find the installed Mastra Studio main bundle.');
}

const assetPath = join(assetDirectory, assetName);
let source = await readFile(assetPath, 'utf8');
const marker = 'personal-docs-supported-attachments';
if (source.includes(marker)) {
  console.log('Mastra Studio document attachment patch is already applied.');
  process.exit(0);
}

const mimeByExtension = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain',
  html: 'text/html',
  pdf: 'application/pdf',
};
const supportedMimes = [...new Set(Object.values(mimeByExtension))];

const replaceOnce = (label, search, replacement) => {
  const count =
    typeof search === 'string'
      ? source.split(search).length - 1
      : (source.match(search) ?? []).length;
  if (count !== 1) {
    throw new Error(`Mastra Studio changed: expected one ${label} pattern.`);
  }
  source = source.replace(search, replacement);
};

replaceOnce(
  'attachment MIME fallback',
  'e.type||"text/plain"',
  `({${Object.entries(mimeByExtension)
    .map(([extension, mimeType]) => `${JSON.stringify(extension)}:${JSON.stringify(mimeType)}`)
    .join(',')}}[e.name.split(".").pop()?.toLowerCase()]||e.type||"application/octet-stream")`,
);

replaceOnce(
  'attachment classifier',
  /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>\2\.startsWith\("image\/"\)\?"image":\2==="application\/pdf"\?"pdf":\2\.startsWith\("video\/"\)\|\|\2\.startsWith\("audio\/"\)\?"video":"text"/g,
  (_match, functionName, argumentName) =>
    `${functionName}=${argumentName}=>${argumentName}.startsWith("image/")?"image":${argumentName}==="application/pdf"?"pdf":${argumentName}.startsWith("video/")||${argumentName}.startsWith("audio/")?"video":/* ${marker} */${JSON.stringify(supportedMimes)}.includes(${argumentName})?"file":"text"`,
);

replaceOnce(
  'generic file message conversion',
  ':e.kind==="pdf"?{role:"user",content:[{type:"file"',
  ':(e.kind==="pdf"||e.kind==="file")?{role:"user",content:[{type:"file"',
);

replaceOnce(
  'generic file preview',
  ':e.kind==="pdf"?o.jsx(wFr,{attachment:e}):e.kind==="video"?o.jsx(vDt',
  ':e.kind==="pdf"?o.jsx(wFr,{attachment:e}):(e.kind==="file"||e.kind==="video")?o.jsx(vDt',
);

await writeFile(assetPath, source);
console.log(`Patched ${assetName} to preserve supported documents as binary attachments.`);
