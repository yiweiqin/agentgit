import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const request = JSON.parse(readFileSync(0, 'utf8'));
const failures = [];
for (const file of request.files) {
  try {
    const value = await (await import(pathToFileURL(resolve(file)).href)).run();
    if (value !== request.expected) failures.push({file, expected: request.expected, actual: value ?? null});
  } catch (error) { failures.push({file, error: String(error)}); }
}
if (readFileSync('theme.css', 'utf8') !== ':root { color: navy; }\n') failures.push({file: 'theme.css', error: 'Independent work was lost'});
console.log(JSON.stringify({checks: request.files.length + 1, failures, pass: failures.length === 0}));
process.exitCode = failures.length ? 1 : 0;
