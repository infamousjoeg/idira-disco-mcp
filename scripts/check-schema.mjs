#!/usr/bin/env node
/**
 * Compares schema/disco.graphql with the schema currently published in the Idira docs.
 * Exit code 0: identical. 1: the published schema changed (run with --write to update the
 * local copy, then run the tests: test/schema-coverage.test.ts shows what the server lacks).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DOCS_URL = 'https://docs.cyberark.com/manage/latest/en/content/disco/discovery-context-apis.htm';
const LOCAL = new URL('../schema/disco.graphql', import.meta.url);

// The docs site answers 404 to clients that do not look like a browser.
const response = await fetch(DOCS_URL, {
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
  },
});
if (!response.ok) {
  console.error(`Could not fetch ${DOCS_URL}: HTTP ${response.status}`);
  process.exit(2);
}

const html = await response.text();
const block = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html);
if (!block || !block[1].includes('type Query')) {
  console.error('The docs page no longer contains the schema in a <pre><code> block; update this script.');
  process.exit(2);
}
const entities = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
const published = `${block[1].replace(/\r/g, '').replace(/&(lt|gt|quot|#39|amp);/g, (match) => entities[match])}\n`;
const local = readFileSync(LOCAL, 'utf8').replace(/\r/g, '');

if (published === local) {
  console.log('schema/disco.graphql matches the published schema.');
  process.exit(0);
}

const publishedLines = published.split('\n');
const localLines = new Set(local.split('\n'));
const publishedSet = new Set(publishedLines);
console.log('The published schema differs from schema/disco.graphql.');
for (const line of publishedLines) if (line.trim() && !localLines.has(line)) console.log(`+ ${line}`);
for (const line of local.split('\n')) if (line.trim() && !publishedSet.has(line)) console.log(`- ${line}`);

if (process.argv.includes('--write')) {
  writeFileSync(LOCAL, published);
  console.log('Updated schema/disco.graphql. Run "npm test" to see what the server needs to cover.');
  process.exit(0);
}
process.exit(1);
