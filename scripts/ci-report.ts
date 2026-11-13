// Writes a Markdown report of the test results and of AWS Emulator: which
// version ran and how, what the stack deployed into it, and what it logged.
//
// In GitHub Actions the report is appended to the job summary
// ($GITHUB_STEP_SUMMARY); elsewhere it is printed. Run it with `make report`.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { STACK_NAME } from './lib/emulator.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const SUITES = ['unit', 'functional', 'smoke', 'e2e'];
const LOG_TAIL_LINES = 60;

const unescapeXml = (text: string): string =>
  text.replace(/&(lt|gt|quot|apos|amp|#(\d+));/g, (_, name: string, code?: string) =>
    code ? String.fromCodePoint(Number(code)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name]!,
  );
/** Makes text safe inside a Markdown table cell. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const emulator = (command: string): string | undefined => {
  try {
    return execFileSync(`${root}scripts/emulator.sh`, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

// ---- Tests ------------------------------------------------------------------

interface SuiteResult {
  suite: string;
  passed: number;
  failed: number;
  skipped: number;
  seconds: number;
  failures: { name: string; message: string }[];
}

/** Reads a JUnit report written by `node --test --test-reporter=junit`. */
const readSuite = (suite: string): SuiteResult | undefined => {
  const file = `${root}reports/${suite}.xml`;
  if (!existsSync(file)) return undefined;
  const result: SuiteResult = { suite, passed: 0, failed: 0, skipped: 0, seconds: 0, failures: [] };
  const testcase = /<testcase name="([^"]*)" time="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const [, name = '', time, body = ''] of readFileSync(file, 'utf8').matchAll(testcase)) {
    result.seconds += Number(time);
    if (body.includes('<failure')) {
      result.failed += 1;
      const message = /<failure[^>]*\bmessage="([^"]*)"/.exec(body)?.[1] ?? 'failed';
      result.failures.push({ name: unescapeXml(name), message: unescapeXml(message) });
    } else if (body.includes('<skipped')) result.skipped += 1;
    else result.passed += 1;
  }
  return result;
};

const testReport = (): string[] => {
  const suites = SUITES.map(readSuite).filter((suite) => suite !== undefined);
  if (suites.length === 0) return ['## Tests', '', 'No test reports found in `reports/`.', ''];
  const lines = ['## Tests', '', '| Suite | Result | Passed | Failed | Skipped | Time |', '| --- | --- | ---: | ---: | ---: | ---: |'];
  for (const s of suites) {
    const result = s.failed > 0 ? '❌ failed' : '✅ passed';
    lines.push(`| ${s.suite} | ${result} | ${s.passed} | ${s.failed} | ${s.skipped} | ${s.seconds.toFixed(1)}s |`);
  }
  lines.push('');
  for (const s of suites.filter((suite) => suite.failures.length > 0)) {
    lines.push(`### Failures in ${s.suite}`, '');
    for (const failure of s.failures) lines.push(`- **${failure.name}**: ${cell(failure.message)}`);
    lines.push('');
  }
  return lines;
};

// ---- AWS Emulator -----------------------------------------------------------

const deployedResources = async (): Promise<string[]> => {
  if (!process.env.AWS_ENDPOINT_URL) return [];
  const cloudformation = new CloudFormationClient({});
  try {
    const counts = new Map<string, number>();
    let NextToken: string | undefined;
    do {
      const page = await cloudformation.send(new ListStackResourcesCommand({ StackName: STACK_NAME, NextToken }));
      for (const resource of page.StackResourceSummaries ?? []) {
        const key = `${resource.ResourceType} | ${resource.ResourceStatus}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      NextToken = page.NextToken;
    } while (NextToken);
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    return [
      `### Deployed stack: ${STACK_NAME} (${total} resources)`,
      '',
      '| Resource type | Status | Count |',
      '| --- | --- | ---: |',
      ...[...counts].sort().map(([key, count]) => `| ${key} | ${count} |`),
      '',
    ];
  } catch (error) {
    return [`### Deployed stack: ${STACK_NAME}`, '', `Not deployed (${cell((error as Error).message)}).`, ''];
  } finally {
    cloudformation.destroy();
  }
};

const logReport = (): string[] => {
  const log = emulator('logs');
  if (log === undefined) return ['### Emulator log', '', 'No log available.', ''];
  const lines = log.split('\n').filter(Boolean);
  const levels = new Map<string, number>();
  const problems = new Map<string, number>();
  for (const line of lines) {
    let entry: { level?: string; fields?: { message?: string; reason?: string } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the telemetry notice is plain text
    }
    const level = entry.level ?? 'UNKNOWN';
    levels.set(level, (levels.get(level) ?? 0) + 1);
    if (level === 'WARN' || level === 'ERROR') {
      const reason = entry.fields?.reason ? ` (${entry.fields.reason})` : '';
      const key = `${level} | ${cell(`${entry.fields?.message ?? ''}${reason}`)}`;
      problems.set(key, (problems.get(key) ?? 0) + 1);
    }
  }
  const summary = [...levels].sort().map(([level, count]) => `${count} ${level}`).join(', ') || 'empty';
  const out = ['### Emulator log', '', `${lines.length} lines: ${summary}.`, ''];
  if (problems.size > 0) {
    out.push('| Level | Message | Count |', '| --- | --- | ---: |');
    for (const [key, count] of problems) out.push(`| ${key} | ${count} |`);
    out.push('');
  }
  out.push(
    `<details><summary>Last ${Math.min(LOG_TAIL_LINES, lines.length)} log lines</summary>`,
    '',
    '```json',
    ...lines.slice(-LOG_TAIL_LINES),
    '```',
    '',
    '</details>',
    '',
  );
  return out;
};

const emulatorReport = async (): Promise<string[]> => {
  const version = emulator('version');
  const status = emulator('status');
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(version ?? '')?.[1] ?? 'unknown';
  return [
    '## AWS Emulator',
    '',
    '| | |',
    '| --- | --- |',
    `| Version | ${field('Version')} (released ${field('Release date')}) |`,
    `| Commit | \`${field('Commit')}\` |`,
    `| Runtime | ${process.env.DEV_CONTAINER_RUNTIME ? `dev container (${process.env.DEV_CONTAINER_RUNTIME})` : (emulator('runtime') ?? 'unknown')} |`,
    `| Status | ${status ?? 'not running'} |`,
    '',
    ...(await deployedResources()),
    ...logReport(),
  ];
};

// ---- Output -----------------------------------------------------------------

const tests = testReport();
// Jobs that never start the emulator (unit tests) report on tests only.
const report = [...tests, ...(process.env.AWS_ENDPOINT_URL ? await emulatorReport() : [])].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
else console.log(report);
