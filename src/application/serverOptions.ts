import { AppError } from '../contracts/errors';
import type { GameServerOptionRow } from '../contracts/tables';
import type { DatasetRuntime, DatasetToken } from '../storage/datasetRuntime';
import type { ServerOptionDraft } from './contracts';
import { requireText } from './guards';

export interface ServerOptionDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

const MAX_OPTIONS_PER_GAME = 50;

/**
 * 按游戏名维护的区服选项（UF-005）。删除或修改选项不影响已填账号的区服文本。
 */
export function createServerOptionServices({ runtime, newId }: ServerOptionDeps) {
  return {
    async list(gameName: string): Promise<
      { id: string; gameName: string; name: string; sortOrder: number }[]
    > {
      const key = gameName.trim().toLowerCase();
      return runtime.read((ctx) =>
        ctx.data.game_server_options
          .filter((row) => row.gameName.trim().toLowerCase() === key)
          .sort((left, right) => left.sortOrder - right.sortOrder)
          .map((row) => ({
            id: row.id,
            gameName: row.gameName,
            name: row.name,
            sortOrder: row.sortOrder,
          })),
      );
    },

    async listAll(): Promise<
      { gameName: string; options: { id: string; name: string; sortOrder: number }[] }[]
    > {
      return runtime.read((ctx) => {
        const groups = new Map<string, GameServerOptionRow[]>();
        for (const row of ctx.data.game_server_options) {
          const key = row.gameName.trim().toLowerCase();
          const bucket = groups.get(key) ?? [];
          bucket.push(row);
          groups.set(key, bucket);
        }
        return [...groups.entries()]
          .map(([, rows]) => ({
            gameName: rows[0].gameName,
            options: rows
              .sort((left, right) => left.sortOrder - right.sortOrder)
              .map((row) => ({ id: row.id, name: row.name, sortOrder: row.sortOrder })),
          }))
          .sort((left, right) => left.gameName.localeCompare(right.gameName, 'zh-CN'));
      });
    },

    async save(input: ServerOptionDraft, token: DatasetToken): Promise<string> {
      const gameName = requireText(input.gameName, '游戏名称', 1, 40);
      const name = requireText(input.name, '区服名称', 1, 60);
      return runtime.write(token, async (ctx) => {
        const existing = input.id
          ? ctx.data.game_server_options.find((row) => row.id === input.id)
          : undefined;
        if (input.id && !existing) throw new AppError('NOT_FOUND', '区服选项不存在');
        const sameGame = ctx.data.game_server_options
          .filter(
            (row) =>
              row.gameName.trim().toLowerCase() === gameName.toLowerCase() && row.id !== existing?.id,
          )
          .sort((left, right) => left.sortOrder - right.sortOrder);
        if (sameGame.some((row) => row.name.trim().toLowerCase() === name.toLowerCase())) {
          throw new AppError('CONFLICT', '该游戏已有同名区服选项');
        }
        if (!existing && sameGame.length >= MAX_OPTIONS_PER_GAME) {
          throw new AppError('INVALID_INPUT', `每个游戏最多 ${MAX_OPTIONS_PER_GAME} 个区服选项`);
        }
        if (existing) {
          const row: GameServerOptionRow = {
            ...existing,
            gameName,
            name,
          };
          await ctx.table('game_server_options').put(row);
          return row.id;
        }
        const row: GameServerOptionRow = {
          id: newId(),
          gameName,
          name,
          sortOrder: sameGame.length,
        };
        await ctx.table('game_server_options').add(row);
        return row.id;
      });
    },

    async remove(id: string, token: DatasetToken): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const existing = ctx.data.game_server_options.find((row) => row.id === id);
        if (!existing) return;
        await ctx.table('game_server_options').delete(id);
        // 重排剩余选项，保持连续排序。
        const sameGame = ctx.data.game_server_options
          .filter(
            (row) =>
              row.gameName.trim().toLowerCase() === existing.gameName.trim().toLowerCase() &&
              row.id !== id,
          )
          .sort((left, right) => left.sortOrder - right.sortOrder);
        for (let index = 0; index < sameGame.length; index += 1) {
          if (sameGame[index].sortOrder !== index) {
            await ctx.table('game_server_options').put({ ...sameGame[index], sortOrder: index });
          }
        }
      });
    },
  };
}
