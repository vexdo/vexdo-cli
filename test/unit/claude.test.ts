import { beforeEach, describe, expect, it, vi } from 'vitest';

const { messagesCreateMock, anthropicCtorMock } = vi.hoisted(() => {
  const create = vi.fn();
  const ctor = vi.fn(() => ({
    messages: {
      create,
    },
  }));

  return {
    messagesCreateMock: create,
    anthropicCtorMock: ctor,
  };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: anthropicCtorMock,
}));

import { ClaudeClient, ClaudeError } from '../../src/lib/claude.js';

describe('ClaudeClient', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    anthropicCtorMock.mockClear();
  });

  it('runReviewer parses valid JSON response correctly', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: '{"comments":[{"severity":"important","comment":"bad","file":"a.ts","line":4}]}' }],
    });

    const client = new ClaudeClient('test-key');
    const result = await client.runReviewer({ spec: 'spec', diff: 'diff', model: 'claude' });

    expect(result).toEqual({
      comments: [{ severity: 'important', comment: 'bad', file: 'a.ts', line: 4 }],
    });
  });

  it('runReviewer strips markdown code fences before parsing', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '```json\n{"comments":[{"severity":"minor","comment":"nit"}]}\n```',
        },
      ],
    });

    const client = new ClaudeClient('test-key');
    const result = await client.runReviewer({ spec: 'spec', diff: 'diff', model: 'claude' });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({ severity: 'minor', comment: 'nit' });
  });

  it('runReviewer retries on network error and succeeds within 3 attempts', async () => {
    messagesCreateMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"comments":[]}' }] });

    const client = new ClaudeClient('test-key');
    const resultPromise = client.runReviewer({ spec: 'spec', diff: 'diff', model: 'claude' });

    await expect(resultPromise).resolves.toEqual({ comments: [] });
    expect(messagesCreateMock).toHaveBeenCalledTimes(3);
  });

  it('runReviewer throws ClaudeError after 3 failures', async () => {
    messagesCreateMock.mockRejectedValue(new Error('always down'));

    const client = new ClaudeClient('test-key');
    await expect(client.runReviewer({ spec: 'spec', diff: 'diff', model: 'claude' })).rejects.toThrow(
      /Claude API failed after 3 attempts/,
    );
  });

  it('runReviewer does NOT retry on 401', async () => {
    const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
    messagesCreateMock.mockRejectedValue(unauthorized);

    const client = new ClaudeClient('test-key');
    await expect(client.runReviewer({ spec: 'spec', diff: 'diff', model: 'claude' })).rejects.toBeInstanceOf(ClaudeError);
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });

  it('runArbiter parses valid JSON response correctly', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '{"decision":"fix","reasoning":"spec violation","feedback_for_codex":"change src/a.ts","summary":"Need fix"}',
        },
      ],
    });

    const client = new ClaudeClient('test-key');
    const result = await client.runArbiter({
      spec: 'spec',
      diff: 'diff',
      model: 'claude',
      reviewComments: [{ severity: 'critical', comment: 'broken' }],
    });

    expect(result).toEqual({
      decision: 'fix',
      reasoning: 'spec violation',
      feedback_for_codex: 'change src/a.ts',
      summary: 'Need fix',
    });
  });
});
