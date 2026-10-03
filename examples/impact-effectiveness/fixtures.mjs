/** Small executable applications; behavior truth is checked by a separate Node process. */
export const channels = ['web', 'mobile', 'cli', 'worker', 'admin', 'export']

export function fixture(scenario) {
  const authV1 = "export function login() { return {token: 'abc', expiresAt: 3600}; }\n"
  const authV2 = "export function login() { return {accessToken: 'abc', expiresAt: 3600}; }\n"
  const cases = {
    auth: [authV1, authV2, 'login', 'login().token', 'login().accessToken', 'abc'],
    expiry: [authV1, authV2, 'login', 'login().expiresAt', 'login().expiresAt', 3600],
    compatible: [authV1, authV1.replace('expiresAt: 3600', "expiresAt: 3600, scope: 'read'"), 'login', 'login().token', 'login().token', 'abc'],
    dual: [authV1.replace("token: 'abc'", "token: 'abc', accessToken: 'abc'"), authV2, 'login', 'login().accessToken', 'login().accessToken', 'abc'],
    amount: ['export function amount() { return 1250; }\n', 'export function amount() { return 12.5; }\n', 'amount', 'amount() / 100', 'amount()', 12.5],
    async: [authV1, authV1.replace('export function', 'export async function'), 'login', 'login().token', '(await login()).token', 'abc'],
  }
  const [before, after, symbol, oldExpression, newExpression, expected] = cases[scenario.family]
  return {
    before, after: scenario.id === 'no-public-change' ? before + '// Internal implementation comment.\n' : after,
    expected, contract: `service.${symbol}`,
    oldSpec: { version: scenario.initialVersion ?? 1, symbol, expression: oldExpression },
    newSpec: { version: 2, symbol, expression: newExpression },
  }
}

export function artifact(scenario, channel, spec) {
  if (scenario.shared && channel !== 'adapter') {
    return "import { adapt } from '../adapter.mjs';\nexport async function run() { return await adapt(); }\n"
  }
  const path = channel === 'adapter' ? './producer.mjs' : '../producer.mjs'
  const name = channel === 'adapter' ? 'adapt' : 'run'
  return `import { ${spec.symbol} } from '${path}';\nexport async function ${name}() { return ${spec.expression}; }\n`
}

// This validator does not import the coordination implementation or use its classifications.
export const validator = `import { readFileSync } from 'node:fs';
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
if (readFileSync('theme.css', 'utf8') !== ':root { color: navy; }\\n') failures.push({file: 'theme.css', error: 'Independent work was lost'});
console.log(JSON.stringify({checks: request.files.length + 1, failures, pass: failures.length === 0}));
process.exitCode = failures.length ? 1 : 0;
`
