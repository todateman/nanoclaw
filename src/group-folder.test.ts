import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcInputPath,
  resolveGroupIpcPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });

  it('resolves a per-chat input directory under the group ipc directory', () => {
    const resolved = resolveGroupIpcInputPath('task-bot', 'dc:1234567890');
    expect(
      resolved.endsWith(
        `${path.sep}ipc${path.sep}task-bot${path.sep}input${path.sep}dc_1234567890`,
      ),
    ).toBe(true);
  });

  it('gives chats sharing a folder distinct input directories', () => {
    expect(resolveGroupIpcInputPath('task-bot', 'dc:111')).not.toBe(
      resolveGroupIpcInputPath('task-bot', 'dc:222'),
    );
  });

  it('keeps hostile chat JIDs inside the input directory', () => {
    const base = path.join(resolveGroupIpcPath('task-bot'), 'input');
    const resolved = resolveGroupIpcInputPath('task-bot', '../../etc/passwd');
    expect(path.dirname(resolved)).toBe(base);
    expect(() => resolveGroupIpcInputPath('../../etc', 'dc:1')).toThrow();
    expect(() => resolveGroupIpcInputPath('task-bot', '')).toThrow();
  });
});
