import { Command } from 'commander';

const program = new Command();

program.name('vexdo').description('Vexdo CLI').version('0.1.0');

program.parse(process.argv);
