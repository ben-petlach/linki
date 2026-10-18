// Keep existing upstream lint debt visible without permitting new diagnostics.
const { ESLint } = require('eslint');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const baseline = JSON.parse(fs.readFileSync('tests/lint-baseline.json', 'utf8'));
  const key = (entry) => JSON.stringify(entry);
  const remaining = new Map();
  for (const entry of baseline) remaining.set(key(entry), (remaining.get(key(entry)) || 0) + 1);
  const results = await new ESLint().lintFiles(['.']);
  let inherited = 0;
  let added = 0;
  for (const result of results) {
    const file = path.relative(process.cwd(), result.filePath);
    const source = fs.readFileSync(result.filePath, 'utf8').split(/\r?\n/);
    for (const message of result.messages) {
      const entry = { file, ruleId: message.ruleId, message: message.message,
        severity: message.severity, source: message.line ? source[message.line - 1].trim() : '' };
      const fingerprint = key(entry);
      if (remaining.get(fingerprint) > 0) {
        remaining.set(fingerprint, remaining.get(fingerprint) - 1);
        inherited++;
      } else {
        added++;
        console.error(`${file}:${message.line || 0} ${message.ruleId}: ${message.message}`);
      }
    }
  }
  console.log(`Lint: ${added} new diagnostics; ${inherited} recorded upstream diagnostics remain.`);
  if (added) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
