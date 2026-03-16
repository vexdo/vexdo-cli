import { spawnSync } from 'node:child_process';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { loadBoardState, type BoardState, type TaskSummary } from '../lib/board.js';

interface BoardProps {
  projectRoot: string;
}

type ColumnKey = 'backlog' | 'in_progress' | 'review' | 'done';

interface ColumnDefinition {
  key: ColumnKey;
  title: string;
  tasks: TaskSummary[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function runExternal(command: string, args: string[]): { ok: boolean; message: string } {
  const wasRaw = process.stdin.isTTY && process.stdin.isRaw;
  if (process.stdin.isTTY && wasRaw) {
    process.stdin.setRawMode(false);
  }

  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (process.stdin.isTTY && wasRaw) {
    process.stdin.setRawMode(true);
  }

  if (result.error) {
    return {
      ok: false,
      message: result.error.message,
    };
  }

  return {
    ok: result.status === 0,
    message: result.status === 0 ? 'Command completed.' : `Command exited with status ${String(result.status)}.`,
  };
}

function openInEditor(filePath: string): { ok: boolean; message: string } {
  const editor = process.env.EDITOR;
  if (!editor) {
    return { ok: false, message: 'EDITOR is not set.' };
  }

  return runExternal(editor, [filePath]);
}

function runPrimaryAction(column: ColumnKey, task: TaskSummary): { ok: boolean; message: string } {
  if (task.blocked) {
    return runExternal('vexdo', ['logs', task.id]);
  }

  if (column === 'backlog') {
    return runExternal('vexdo', ['start', task.path]);
  }

  if (column === 'in_progress') {
    return runExternal('vexdo', ['status']);
  }

  if (column === 'review') {
    return runExternal('vexdo', ['submit']);
  }

  return openInEditor(task.path);
}

function TaskCard({ task, selected }: { task: TaskSummary; selected: boolean }): React.JSX.Element {
  const prefix = task.blocked ? '⚠ ' : '';
  return <Text>{`${selected ? '> ' : '  '}${prefix}${task.id}`}</Text>;
}

function Column({
  title,
  count,
  tasks,
  selectedRow,
  active,
}: {
  title: string;
  count: number;
  tasks: TaskSummary[];
  selectedRow: number;
  active: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
      <Text color={active ? 'cyan' : undefined}>{title}</Text>
      <Text dimColor>{`(${String(count)})`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {tasks.length === 0 ? <Text dimColor>  —</Text> : null}
        {tasks.map((task, index) => (
          <TaskCard key={`${task.path}-${task.id}`} task={task} selected={active && index === selectedRow} />
        ))}
      </Box>
    </Box>
  );
}

function StatusBar({
  task,
  column,
  message,
  confirmAbort,
}: {
  task: TaskSummary | undefined;
  column: ColumnKey;
  message: string | null;
  confirmAbort: boolean;
}): React.JSX.Element {
  if (!task) {
    return (
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Text dimColor>No task selected.</Text>
        <Text dimColor>[←/→/↑/↓] navigate  [r] refresh  [q] quit</Text>
      </Box>
    );
  }

  const primaryLabel = task.blocked
    ? '[↵] logs'
    : column === 'backlog'
      ? '[↵] start'
      : column === 'in_progress'
        ? '[↵] status'
        : column === 'review'
          ? '[↵] submit'
          : '[↵] edit';

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text>{`${task.id} · ${task.title}`}</Text>
      <Text>
        {`${primaryLabel}  [e] edit  [l] logs  [a] abort  [r] refresh  [q] quit${confirmAbort ? '  Confirm abort: press [a] again' : ''}`}
      </Text>
      {message ? <Text color="yellow">{message}</Text> : null}
    </Box>
  );
}

export function Board({ projectRoot }: BoardProps): React.JSX.Element {
  const { exit } = useApp();
  const [state, setState] = useState<BoardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState({ column: 0, row: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadBoardState(projectRoot);
      setState(next);
      setMessage(null);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setMessage(`Failed to load board: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const columns = useMemo<ColumnDefinition[]>(() => {
    if (!state) {
      return [
        { key: 'backlog', title: 'BACKLOG', tasks: [] },
        { key: 'in_progress', title: 'IN PROGRESS', tasks: [] },
        { key: 'review', title: 'REVIEW', tasks: [] },
        { key: 'done', title: 'DONE', tasks: [] },
      ];
    }

    return [
      { key: 'backlog', title: 'BACKLOG', tasks: [...state.blocked, ...state.backlog] },
      { key: 'in_progress', title: 'IN PROGRESS', tasks: state.in_progress },
      { key: 'review', title: 'REVIEW', tasks: state.review },
      { key: 'done', title: 'DONE', tasks: state.done },
    ];
  }, [state]);

  const activeColumn = columns[cursor.column] ?? columns[0];
  const selectedTask = activeColumn.tasks.at(cursor.row);

  useEffect(() => {
    const nextColumn = clamp(cursor.column, 0, columns.length - 1);
    const maxRow = Math.max(0, (columns[nextColumn]?.tasks.length ?? 1) - 1);
    const nextRow = clamp(cursor.row, 0, maxRow);

    if (nextColumn !== cursor.column || nextRow !== cursor.row) {
      setCursor({ column: nextColumn, row: nextRow });
    }
  }, [columns, cursor.column, cursor.row]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }

    if (key.leftArrow) {
      setConfirmAbort(false);
      setCursor((prev) => {
        const nextColumn = clamp(prev.column - 1, 0, columns.length - 1);
        const maxRow = Math.max(0, columns[nextColumn].tasks.length - 1);
        return { column: nextColumn, row: clamp(prev.row, 0, maxRow) };
      });
      return;
    }

    if (key.rightArrow) {
      setConfirmAbort(false);
      setCursor((prev) => {
        const nextColumn = clamp(prev.column + 1, 0, columns.length - 1);
        const maxRow = Math.max(0, columns[nextColumn].tasks.length - 1);
        return { column: nextColumn, row: clamp(prev.row, 0, maxRow) };
      });
      return;
    }

    if (key.upArrow) {
      setConfirmAbort(false);
      setCursor((prev) => ({ ...prev, row: clamp(prev.row - 1, 0, Math.max(0, activeColumn.tasks.length - 1)) }));
      return;
    }

    if (key.downArrow) {
      setConfirmAbort(false);
      setCursor((prev) => ({ ...prev, row: clamp(prev.row + 1, 0, Math.max(0, activeColumn.tasks.length - 1)) }));
      return;
    }

    if (input === 'r') {
      setConfirmAbort(false);
      void refresh();
      return;
    }

    if (key.return && selectedTask) {
      const result = runPrimaryAction(activeColumn.key, selectedTask);
      setMessage(result.message);
      setConfirmAbort(false);
      void refresh();
      return;
    }

    if (input === 'e' && selectedTask) {
      const result = openInEditor(selectedTask.path);
      setMessage(result.message);
      setConfirmAbort(false);
      return;
    }

    if (input === 'l' && selectedTask) {
      const result = runExternal('vexdo', ['logs', selectedTask.id]);
      setMessage(result.message);
      setConfirmAbort(false);
      return;
    }

    if (input === 'a' && selectedTask) {
      if (!confirmAbort) {
        setConfirmAbort(true);
        setMessage(`Confirm abort task '${selectedTask.id}' by pressing 'a' again.`);
        return;
      }

      const result = runExternal('vexdo', ['abort']);
      setMessage(result.message);
      setConfirmAbort(false);
      void refresh();
    }
  });

  const terminalRows = typeof process.stdout.rows === 'number' ? process.stdout.rows : 24;

  return (
    <Box flexDirection="column" height={terminalRows}>
      <Box justifyContent="space-between" borderStyle="single" paddingX={1}>
        <Text>vexdo board</Text>
        <Text>[q] quit</Text>
      </Box>

      {loading ? (
        <Box borderStyle="single" paddingX={1}>
          <Text>Loading tasks…</Text>
        </Box>
      ) : (
        <Box flexGrow={1}>
          {columns.map((column, index) => (
            <Column
              key={column.key}
              title={column.title}
              count={column.tasks.length}
              tasks={column.tasks}
              selectedRow={cursor.row}
              active={index === cursor.column}
            />
          ))}
        </Box>
      )}

      <StatusBar task={selectedTask} column={activeColumn.key} message={message} confirmAbort={confirmAbort} />
    </Box>
  );
}
