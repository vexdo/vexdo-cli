import type { Command } from 'commander';
import React from 'react';
import { render } from 'ink';

import { Board } from '../components/Board.js';
import { findProjectRoot } from '../lib/config.js';
import * as logger from '../lib/logger.js';

function fatalAndExit(message: string): never {
  logger.fatal(message);
  process.exit(1);
}

export async function runBoard(): Promise<void> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    fatalAndExit('Not inside a vexdo project.');
  }

  const instance = render(<Board projectRoot={projectRoot} />);
  await instance.waitUntilExit();
}

export function registerBoardCommand(program: Command): void {
  program.command('board').description('Open interactive task board').action(() => {
    void runBoard();
  });
}
