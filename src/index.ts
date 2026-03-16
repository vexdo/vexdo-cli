import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { registerAbortCommand } from './commands/abort.js';
import { registerBoardCommand } from './commands/board.js';
import { registerFixCommand } from './commands/fix.js';
import { registerInitCommand } from './commands/init.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerReviewCommand } from './commands/review.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatusCommand } from './commands/status.js';
import { registerSubmitCommand } from './commands/submit.js';
import * as logger from './lib/logger.js';

const packageJsonPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string };

const program = new Command();

program
  .name('vexdo')
  .description('Vexdo CLI')
  .version(packageJson.version)
  .option('--verbose', 'Enable verbose logs')
  .option('--dry-run', 'Print plan without making changes');

program.hook('preAction', (_thisCommand, actionCommand) => {
  const globalOpts = actionCommand.optsWithGlobals();
  logger.setVerbose(Boolean(globalOpts.verbose));
});

registerInitCommand(program);
registerStartCommand(program);
registerReviewCommand(program);
registerFixCommand(program);
registerSubmitCommand(program);
registerStatusCommand(program);
registerAbortCommand(program);
registerLogsCommand(program);
registerBoardCommand(program);

program.parse(process.argv);
