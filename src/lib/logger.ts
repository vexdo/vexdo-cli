import ora from 'ora';
import type { Ora } from 'ora';
import pc from 'picocolors';


let verboseEnabled = false;

export interface Logger {
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
  iteration: (n: number, max: number) => void;
  reviewSummary: (comments: ReviewComment[]) => void;
}

function safeLog(method: 'log' | 'error', message: string): void {
  try {
    if (method === 'error') {
      console.error(message);
    } else {
      console.log(message);
    }
  } catch {
    // never throw
  }
}

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function info(message: string): void {
  safeLog('log', `${pc.cyan('→')} ${message}`);
}

export function success(message: string): void {
  safeLog('log', `${pc.green('✓')} ${message}`);
}

export function warn(message: string): void {
  safeLog('log', `${pc.yellow('⚠')} ${message}`);
}

export function error(message: string): void {
  safeLog('error', `${pc.red('✖')} ${message}`);
}

export function debug(message: string): void {
  if (!verboseEnabled) {
    return;
  }
  safeLog('log', `${pc.gray('•')} ${message}`);
}

export function header(title: string): void {
  safeLog('log', `${pc.bold(pc.white(title))}\n${pc.gray('─'.repeat(title.length))}`);
}

export function step(n: number, total: number, title: string): void {
  safeLog('log', `${pc.bold(`Step ${String(n)}/${String(total)}:`)} ${title}`);
}

export function iteration(n: number, max: number): void {
  safeLog('log', pc.gray(`Iteration ${String(n)}/${String(max)}`));
}

export function fatal(message: string, hint?: string): void {
  safeLog('error', `${pc.bold(pc.red('Error:'))} ${message}`);
  if (hint) {
    safeLog('error', `${pc.gray('Hint:')} ${hint}`);
  }
}

export function spinner(text: string): Ora {
  try {
    return ora({ text });
  } catch {
    return ora({ text: '' });
  }
}

export function escalation(context: {
  taskId: string;
  service: string;
  iteration: number;
  spec: string;
  diff: string;
  reviewText: string;
  arbiterReasoning: string;
  summary: string;
}): void {
  const lines = [
    pc.bold(pc.red('Escalation triggered')),
    `${pc.gray('Task:')} ${context.taskId}`,
    `${pc.gray('Service:')} ${context.service}`,
    `${pc.gray('Iteration:')} ${String(context.iteration)}`,
    `${pc.gray('Summary:')} ${context.summary}`,
    '',
    pc.bold('Spec:'),
    context.spec,
    '',
    pc.bold('Arbiter reasoning:'),
    context.arbiterReasoning,
    '',
    pc.bold('Review:'),
    context.reviewText,
    '',
    pc.bold('Diff:'),
    context.diff,
    '',
    pc.gray('Hint: run `vexdo abort` to clear state.'),
  ];

  safeLog('error', lines.join('\n'));
}

export function reviewSummary(comments: ReviewComment[]): void {
  const counts = {
    critical: 0,
    important: 0,
    minor: 0,
    noise: 0,
  };

  for (const comment of comments) {
    counts[comment.severity] += 1;
  }

  safeLog(
    'log',
    `${pc.bold('Review:')} ${String(counts.critical)} critical ${String(counts.important)} important ${String(counts.minor)} minor`,
  );

  for (const comment of comments) {
    if (comment.severity === 'noise') {
      continue;
    }

    const location = comment.file ? ` (${comment.file}${comment.line ? `:${String(comment.line)}` : ''})` : '';
    safeLog('log', `- ${comment.severity}${location}: ${comment.comment}`);
  }
}

function prefixed(prefix: string, message: string): string {
  return `${prefix}  ${message}`;
}

export function withPrefix(prefix: string): Logger {
  return {
    info: (message: string) => {
      info(prefixed(prefix, message));
    },
    success: (message: string) => {
      success(prefixed(prefix, message));
    },
    warn: (message: string) => {
      warn(prefixed(prefix, message));
    },
    error: (message: string) => {
      error(prefixed(prefix, message));
    },
    debug: (message: string) => {
      debug(prefixed(prefix, message));
    },
    iteration: (n: number, max: number) => {
      safeLog('log', prefixed(prefix, pc.gray(`Iteration ${String(n)}/${String(max)}`)));
    },
    reviewSummary: (comments: ReviewComment[]) => {
      const counts = {
        critical: 0,
        important: 0,
        minor: 0,
        noise: 0,
      };

      for (const comment of comments) {
        counts[comment.severity] += 1;
      }

      safeLog(
        'log',
        prefixed(
          prefix,
          `${pc.bold('Review:')} ${String(counts.critical)} critical ${String(counts.important)} important ${String(counts.minor)} minor`,
        ),
      );

      for (const comment of comments) {
        if (comment.severity === 'noise') {
          continue;
        }

        const location = comment.file ? ` (${comment.file}${comment.line ? `:${String(comment.line)}` : ''})` : '';
        safeLog('log', prefixed(prefix, `- ${comment.severity}${location}: ${comment.comment}`));
      }
    },
  };
}
