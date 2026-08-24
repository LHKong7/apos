import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { RunEvent, TaskDispatch } from '@apos/contracts';
import { GenericCliRuntime } from './adapter';
import { OPENCODE_PROFILE } from './profile';

const enabled = process.env['APOS_OPENCODE_CONTRACT_TEST'] === '1';
const contractTest = enabled ? it : it.skip;
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

contractTest(
  'real OpenCode model writes the required output file before reporting completion',
  async () => {
    const apiKey = process.env['APOS_AGENT_OPENCODE_API_KEY'];
    if (!apiKey) throw new Error('APOS_AGENT_OPENCODE_API_KEY is required for the contract test');

    const workspace = await mkdtemp(join(tmpdir(), 'apos-opencode-contract-'));
    workspaces.push(workspace);
    const runId = randomUUID();
    const runtime = new GenericCliRuntime(OPENCODE_PROFILE, {
      apiKey,
      model: process.env['APOS_OPENCODE_CONTRACT_MODEL'],
      binary: process.env['APOS_OPENCODE_BINARY'] ?? 'opencode',
    });
    const task: TaskDispatch = {
      runId,
      idempotencyKey: `contract:${runId}`,
      agent: { name: 'OpenCode contract test', type: 'planner', description: null, skills: [] },
      outputLocale: 'en',
      goal: {
        title: 'Write the APOS output contract fixture',
        description:
          'Create apos-output.json in the current working directory. Its complete JSON value must be {"contract":"apos","ok":true}. Do not only print the JSON.',
        acceptanceCriteria: [
          { id: 'output-file', text: 'apos-output.json exists and contains the exact requested JSON object' },
        ],
        constraints: [],
      },
      context: [],
      permissions: {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
        deniedTools: [],
        resourceScopes: [{ kind: 'repo', ref: 'contract-workspace', access: 'write' }],
      },
      policyGates: [],
      workspace: {
        path: workspace,
        writable: true,
        additionalPaths: [],
        vcs: null,
      },
      limits: { maxTokens: null, maxCostUsd: null, maxDurationSeconds: 120 },
      model: process.env['APOS_OPENCODE_CONTRACT_MODEL'] ?? null,
      callback: { eventsUrl: 'inline://contract', token: runId },
    };

    const ack = await runtime.dispatch(task);
    expect(ack.accepted).toBe(true);
    const events: RunEvent[] = [];
    let resolveEnded: () => void = () => undefined;
    let rejectEnded: (error: Error) => void = () => undefined;
    const ended = new Promise<void>((resolve, reject) => {
      resolveEnded = resolve;
      rejectEnded = reject;
    });
    const timer = setTimeout(
      () => rejectEnded(new Error('OpenCode contract run timed out')),
      150_000,
    );
    await runtime.subscribe(runId, async (event) => {
      events.push(event);
      if (event.type === 'run_ended') {
        clearTimeout(timer);
        resolveEnded();
      }
    });
    await ended;

    expect(events.at(-1)).toMatchObject({ type: 'run_ended', outcome: 'completed' });
    const output = JSON.parse(await readFile(join(workspace, 'apos-output.json'), 'utf8'));
    expect(output).toEqual({ contract: 'apos', ok: true });
  },
  180_000,
);
