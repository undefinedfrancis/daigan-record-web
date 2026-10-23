import { AppError } from '../contracts/errors';
import type { AccountCategoryRow, GameAccountRow, OwnerRow } from '../contracts/tables';
import { LIMITS } from '../contracts/tables';
import type { DatasetRuntime, DatasetToken } from '../storage/datasetRuntime';
import type {
  AccountCategorySummary,
  AccountDraft,
  AccountViewFilter,
  AccountViewRow,
} from './contracts';
import { addCascadeCounts, deleteOrderCascade, emptyCascadeCounts, type CascadeCounts } from './cascade';
import {
  assertArchivable,
  mustFindAccount,
  mustFindOwner,
  optionalText,
  orderIdsOfAccount,
  orderIdsOfOwner,
  requireText,
} from './guards';

export interface AccountDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

export function createAccountServices({ runtime, newId, now }: AccountDeps) {
  async function previewAccountDeletion(id: string): Promise<CascadeCounts> {
    return runtime.read((ctx) => {
      mustFindAccount(ctx.data, id);
      return ctx.data.orders
        .filter((order) => order.accountId === id)
        .reduce(
          (total, order) => addCascadeCounts(total, countOrderCascade(ctx.data, order.id)),
          emptyCascadeCounts(),
        );
    });
  }

  async function previewOwnerDeletion(id: string): Promise<CascadeCounts> {
    return runtime.read((ctx) => {
      mustFindOwner(ctx.data, id);
      let total = emptyCascadeCounts();
      for (const orderId of orderIdsOfOwner(ctx.data, id)) {
        total = addCascadeCounts(total, countOrderCascade(ctx.data, orderId));
      }
      return total;
    });
  }

  return {
    async saveOwner(
      input: { id?: string; nickname: string },
      token: DatasetToken,
    ): Promise<string> {
      const nickname = requireText(input.nickname, '老板昵称', 1, 30);
      return runtime.write(token, async (ctx) => {
        if (input.id) {
          const existing = await ctx.table('owners').get(input.id);
          if (!existing) throw new AppError('NOT_FOUND', '老板不存在');
          await ctx.table('owners').put({ ...existing, nickname, updatedAt: now() });
          return existing.id;
        }
        const sequence = await ctx.table('owner_number_sequence').get(0);
        const nextNumber = sequence?.nextNumber ?? 1;
        await ctx.table('owner_number_sequence').put({ id: 0, nextNumber: nextNumber + 1 });
        const row: OwnerRow = {
          id: newId(),
          number: nextNumber,
          nickname,
          createdAt: now(),
          updatedAt: now(),
          archivedAt: null,
          archiveBatchId: null,
        };
        await ctx.table('owners').add(row);
        return row.id;
      });
    },

    async saveAccount(input: AccountDraft, token: DatasetToken): Promise<string> {
      const gameName = requireText(input.gameName, '游戏名', 1, 40);
      const server = requireText(input.server, '区服', 1, 40);
      const uid = requireText(input.uid, 'UID', 1, 60);
      const loginAccount = requireText(input.loginAccount, '登录账号', 1, 60);
      const loginDevice = (input.loginDevice ?? '').trim().slice(0, 60) || null;
      const resourceNotes = optionalText(input.resourceNotes ?? null, 4000, '游戏资源记录');
      const password =
        input.loginMethod === 'PASSWORD' ? (input.password ?? '').trim() || null : null;
      if (input.loginMethod === 'PASSWORD' && !password) {
        throw new AppError('INVALID_INPUT', '密码登录必须填写密码');
      }
      const categoryId = input.categoryId ?? null;

      return runtime.write(token, async (ctx) => {
        const owner = mustFindOwner(ctx.data, input.ownerId);
        if (owner.archivedAt !== null) {
          throw new AppError('ARCHIVED_OWNER', '老板已归档，不能新增或修改账号');
        }
        if (categoryId !== null && !ctx.data.account_categories.some((row) => row.id === categoryId)) {
          throw new AppError('INVALID_INPUT', '账号分类不存在');
        }
        if (input.id) {
          const existing = mustFindAccount(ctx.data, input.id);
          if (existing.archivedAt !== null) {
            throw new AppError('ARCHIVED_ACCOUNT', '账号已归档，请先恢复再修改');
          }
          const updated: GameAccountRow = {
            ...existing,
            gameName,
            server,
            uid,
            loginAccount,
            loginMethod: input.loginMethod,
            password,
            defaultTemplateId: input.defaultTemplateId ?? null,
            loginDevice,
            resourceNotes,
            categoryId,
            updatedAt: now(),
          };
          await ctx.table('game_accounts').put(updated);
          return updated.id;
        }
        const row: GameAccountRow = {
          id: newId(),
          ownerId: input.ownerId,
          gameName,
          server,
          uid,
          loginAccount,
          loginMethod: input.loginMethod,
          password,
          createdAt: now(),
          updatedAt: now(),
          archivedAt: null,
          archiveBatchId: null,
          defaultTemplateId: input.defaultTemplateId ?? null,
          loginDevice,
          resourceNotes,
          // UF-037：可在建号时直接选定/新建分类；未选择即未分类。
          categoryId,
        };
        await ctx.table('game_accounts').add(row);
        return row.id;
      });
    },

    async archive(kind: 'owner' | 'account', id: string, token: DatasetToken): Promise<void> {
      return runtime.write(token, async (ctx) => {
        if (kind === 'owner') {
          const owner = mustFindOwner(ctx.data, id);
          if (owner.archivedAt !== null) return;
          assertArchivable(ctx.data, orderIdsOfOwner(ctx.data, id), now(), 'owner');
          const batchId = newId();
          const stamp = now();
          await ctx.table('owners').put({
            ...owner,
            archivedAt: stamp,
            archiveBatchId: batchId,
            updatedAt: stamp,
          });
          const accounts = ctx.data.game_accounts.filter(
            (account) => account.ownerId === id && account.archivedAt === null,
          );
          for (const account of accounts) {
            await ctx.table('game_accounts').put({
              ...account,
              archivedAt: stamp,
              archiveBatchId: batchId,
              updatedAt: stamp,
            });
          }
          return;
        }
        const account = mustFindAccount(ctx.data, id);
        if (account.archivedAt !== null) return;
        assertArchivable(ctx.data, orderIdsOfAccount(ctx.data, id), now(), 'account');
        await ctx.table('game_accounts').put({
          ...account,
          archivedAt: now(),
          archiveBatchId: null,
          updatedAt: now(),
        });
      });
    },

    async restore(kind: 'owner' | 'account', id: string, token: DatasetToken): Promise<void> {
      return runtime.write(token, async (ctx) => {
        if (kind === 'owner') {
          const owner = mustFindOwner(ctx.data, id);
          const batchId = owner.archiveBatchId;
          await ctx.table('owners').put({
            ...owner,
            archivedAt: null,
            archiveBatchId: null,
            updatedAt: now(),
          });
          if (!batchId) return;
          const accounts = ctx.data.game_accounts.filter(
            (account) => account.archiveBatchId === batchId,
          );
          for (const account of accounts) {
            await ctx.table('game_accounts').put({
              ...account,
              archivedAt: null,
              archiveBatchId: null,
              updatedAt: now(),
            });
          }
          return;
        }
        const account = mustFindAccount(ctx.data, id);
        await ctx.table('game_accounts').put({
          ...account,
          archivedAt: null,
          archiveBatchId: null,
          updatedAt: now(),
        });
      });
    },

    async previewAccountDeletion(id: string): Promise<CascadeCounts> {
      return previewAccountDeletion(id);
    },

    async deleteAccount(id: string, token: DatasetToken): Promise<CascadeCounts> {
      return runtime.write(token, async (ctx) => {
        mustFindAccount(ctx.data, id);
        const orderIds = orderIdsOfAccount(ctx.data, id);
        let total = emptyCascadeCounts();
        for (const orderId of orderIds) {
          total = addCascadeCounts(total, await deleteOrderCascade(ctx, orderId));
        }
        await ctx.table('game_accounts').delete(id);
        return total;
      });
    },

    /** 删除已归档老板及其全部账号与派生记录；未归档的老板必须先归档。 */
    async deleteOwner(id: string, token: DatasetToken): Promise<CascadeCounts> {
      return runtime.write(token, async (ctx) => {
        const owner = mustFindOwner(ctx.data, id);
        if (owner.archivedAt === null) {
          throw new AppError('CONFLICT', '只有已归档的老板可以删除；未归档请先归档');
        }
        const accountIds = ctx.data.game_accounts
          .filter((account) => account.ownerId === id)
          .map((account) => account.id);
        let total = emptyCascadeCounts();
        for (const orderId of orderIdsOfOwner(ctx.data, id)) {
          total = addCascadeCounts(total, await deleteOrderCascade(ctx, orderId));
        }
        for (const accountId of accountIds) {
          await ctx.table('game_accounts').delete(accountId);
        }
        await ctx.table('owners').delete(id);
        return total;
      });
    },

    async previewOwnerDeletion(id: string): Promise<CascadeCounts> {
      return previewOwnerDeletion(id);
    },

    /** UF-037：全部分类（含账号数），按 sortOrder/名称排序。 */
    async categories(): Promise<AccountCategorySummary[]> {
      return runtime.read((ctx) =>
        [...ctx.data.account_categories]
          .sort((left, right) =>
            left.sortOrder === right.sortOrder
              ? left.name.localeCompare(right.name)
              : left.sortOrder - right.sortOrder,
          )
          .map((category) => ({
            id: category.id,
            name: category.name,
            sortOrder: category.sortOrder,
            accountCount: ctx.data.game_accounts.filter(
              (account) => account.categoryId === category.id,
            ).length,
          })),
      );
    },

    async createCategory(
      input: { name: string; sortOrder?: number },
      token: DatasetToken,
    ): Promise<{ categoryId: string }> {
      const name = requireText(input.name, '分类名称', 1, LIMITS.maxAccountCategoryName);
      return runtime.write(token, async (ctx) => {
        const duplicate = ctx.data.account_categories.some(
          (row) => row.name.trim() === name,
        );
        if (duplicate) throw new AppError('CONFLICT', '已存在同名账号分类');
        const sortOrder =
          input.sortOrder ??
          ctx.data.account_categories.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
        const row: AccountCategoryRow = {
          id: newId(),
          name,
          sortOrder,
          createdAt: now(),
          updatedAt: now(),
        };
        await ctx.table('account_categories').add(row);
        return { categoryId: row.id };
      });
    },

    async renameCategory(
      input: { categoryId: string; name: string },
      token: DatasetToken,
    ): Promise<void> {
      const name = requireText(input.name, '分类名称', 1, LIMITS.maxAccountCategoryName);
      await runtime.write(token, async (ctx) => {
        const category = ctx.data.account_categories.find((row) => row.id === input.categoryId);
        if (!category) throw new AppError('NOT_FOUND', '账号分类不存在');
        const duplicate = ctx.data.account_categories.some(
          (row) => row.id !== category.id && row.name.trim() === name,
        );
        if (duplicate) throw new AppError('CONFLICT', '已存在同名账号分类');
        // 只改分类自身：账号归属、订单、任务与历史都不受影响（同一 categoryId）。
        await ctx.table('account_categories').put({ ...category, name, updatedAt: now() });
      });
    },

    async deleteCategory(
      input: { categoryId: string },
      token: DatasetToken,
    ): Promise<{ unclassifiedAccounts: number }> {
      return runtime.write(token, async (ctx) => {
        const category = ctx.data.account_categories.find((row) => row.id === input.categoryId);
        if (!category) throw new AppError('NOT_FOUND', '账号分类不存在');
        const affected = ctx.data.game_accounts.filter(
          (account) => account.categoryId === category.id,
        );
        // 事务内先置未分类，再删分类：绝不级联删除账号/订单/历史。
        for (const account of affected) {
          await ctx.table('game_accounts').put({
            ...account,
            categoryId: null,
            updatedAt: now(),
          });
        }
        await ctx.table('account_categories').delete(category.id);
        return { unclassifiedAccounts: affected.length };
      });
    },

    async setAccountCategory(
      input: { accountId: string; categoryId: string | null },
      token: DatasetToken,
    ): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const account = mustFindAccount(ctx.data, input.accountId);
        if (
          input.categoryId !== null &&
          !ctx.data.account_categories.some((row) => row.id === input.categoryId)
        ) {
          throw new AppError('INVALID_INPUT', '账号分类不存在');
        }
        if (account.categoryId === input.categoryId) return;
        await ctx.table('game_accounts').put({
          ...account,
          categoryId: input.categoryId,
          updatedAt: now(),
        });
      });
    },

    /** UF-037：跨老板账号视图；每条仍显示所属老板，身份始终是 accountId。 */
    async accountView(filter: AccountViewFilter): Promise<AccountViewRow[]> {
      return runtime.read((ctx) => {
        const data = ctx.data;
        const categoryById = new Map(data.account_categories.map((row) => [row.id, row]));
        const ownerById = new Map(data.owners.map((row) => [row.id, row]));
        const keyword = (filter.keyword ?? '').trim().toLowerCase();
        const ordersByAccount = new Map<string, typeof data.orders>();
        for (const order of data.orders) {
          const list = ordersByAccount.get(order.accountId) ?? [];
          list.push(order);
          ordersByAccount.set(order.accountId, list);
        }
        return data.game_accounts
          .filter((account) => {
            if (!filter.includeArchived && account.archivedAt !== null) return false;
            if (filter.categoryId !== undefined && account.categoryId !== filter.categoryId) {
              return false;
            }
            if (!keyword) return true;
            const owner = ownerById.get(account.ownerId);
            const category = account.categoryId ? categoryById.get(account.categoryId) : null;
            const haystack = [
              account.gameName,
              account.server,
              account.uid,
              account.loginAccount,
              owner?.nickname ?? '',
              owner ? String(owner.number) : '',
              category?.name ?? '',
            ]
              .join(' ')
              .toLowerCase();
            return haystack.includes(keyword);
          })
          .map((account) => {
            const owner = ownerById.get(account.ownerId);
            const category = account.categoryId ? categoryById.get(account.categoryId) : null;
            const orders = ordersByAccount.get(account.id) ?? [];
            return {
              accountId: account.id,
              ownerId: account.ownerId,
              ownerNumber: owner?.number ?? 0,
              ownerName: owner?.nickname ?? '未知老板',
              ownerLabel: owner ? `#${owner.number} ${owner.nickname}` : '未知老板',
              gameName: account.gameName,
              server: account.server,
              uid: account.uid,
              loginAccount: account.loginAccount,
              archived: account.archivedAt !== null,
              categoryId: account.categoryId,
              categoryName: category?.name ?? null,
              orderCount: orders.length,
              activeOrderCount: orders.filter(
                (order) => order.cancelledAt === null && order.completedAt === null,
              ).length,
            };
          })
          .sort((left, right) => {
            const leftOrder = left.categoryId
              ? (categoryById.get(left.categoryId)?.sortOrder ?? 0)
              : -1;
            const rightOrder = right.categoryId
              ? (categoryById.get(right.categoryId)?.sortOrder ?? 0)
              : -1;
            if (leftOrder !== rightOrder) return leftOrder - rightOrder;
            if (left.ownerNumber !== right.ownerNumber) return left.ownerNumber - right.ownerNumber;
            if (left.gameName !== right.gameName) return left.gameName.localeCompare(right.gameName);
            return left.accountId.localeCompare(right.accountId);
          });
      });
    },
  };
}

function countOrderCascade(
  data: Parameters<typeof orderIdsOfAccount>[0],
  orderId: string,
): CascadeCounts {
  const taskIds = new Set(
    data.task_definitions.filter((task) => task.orderId === orderId).map((task) => task.id),
  );
  const occurrences = data.task_occurrences.filter((row) => taskIds.has(row.taskDefinitionId));
  const occurrenceIds = new Set(occurrences.map((row) => row.id));
  return {
    orders: 1,
    periods: data.hosting_periods.filter((row) => row.orderId === orderId).length,
    tasks: taskIds.size,
    occurrences: occurrences.length,
    receipts: data.receipts.filter((row) => row.orderId === orderId).length,
    attachments: data.attachments.filter(
      (row) =>
        (row.taskDefinitionId !== null && taskIds.has(row.taskDefinitionId)) ||
        (row.occurrenceId !== null && occurrenceIds.has(row.occurrenceId)),
    ).length,
    batches: data.completion_batches.filter((batch) => batch.targetId === orderId).length,
  };
}
