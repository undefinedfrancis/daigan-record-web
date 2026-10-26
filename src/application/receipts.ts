import { AppError } from '../contracts/errors';
import type { ReceiptChannel, ReceiptRow } from '../contracts/tables';
import { MONEY_MAX_CENTS, RECEIPT_CHANNELS } from '../contracts/tables';
import type { DatasetRuntime, DatasetToken, WriteContext } from '../storage/datasetRuntime';
import type { AmendCommand, ReceiptCommand, VoidCommand } from './contracts';
import { mustFindOrder, optionalText } from './guards';

export interface ReceiptDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

function validateAmount(amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > MONEY_MAX_CENTS) {
    throw new AppError('AMOUNT_OUT_OF_RANGE', '金额必须在 0.01–99,999,999.99 元之间');
  }
  return amountCents;
}

function validateChannel(channel: ReceiptChannel, note: string | null): void {
  if (!RECEIPT_CHANNELS.includes(channel)) {
    throw new AppError('INVALID_INPUT', '收款渠道不合法');
  }
  if (channel !== 'OTHER' && note) {
    throw new AppError('INVALID_INPUT', '只有“其他”渠道可以填写备注');
  }
}

/** 预填到账时间最多一年，避免误输入把在途款推到很远的月份。 */
export const RECEIPT_FUTURE_LIMIT_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * 到账时间允许在未来（闲鱼等担保交易要等确认收货才到账），
 * 但在到达前不计入实收、也不冲抵待收（见 `domain/ledger`）。
 */
export function assertReceivedAt(receivedAt: number, nowMs: number): void {
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) {
    throw new AppError('INVALID_INPUT', '到账时间不合法');
  }
  if (receivedAt > nowMs + RECEIPT_FUTURE_LIMIT_MS) {
    throw new AppError('INVALID_INPUT', '到账时间最多只能预填一年以内');
  }
}

function paidExcluding(
  ctx: WriteContext,
  predicate: (receipt: ReceiptRow) => boolean,
  excludeReceiptId: string | null,
): number {
  return ctx.data.receipts
    .filter(
      (receipt) =>
        receipt.status === 'ACTIVE' && receipt.id !== excludeReceiptId && predicate(receipt),
    )
    .reduce((sum, receipt) => sum + receipt.amountCents, 0);
}

export function createReceiptServices({ runtime, newId, now }: ReceiptDeps) {
  return {
    async record(input: ReceiptCommand, token: DatasetToken): Promise<string> {
      validateAmount(input.amountCents);
      const note = input.channel === 'OTHER' ? optionalText(input.note, 200, '备注') : null;
      validateChannel(input.channel, note);
      assertReceivedAt(input.receivedAt, now());

      return runtime.write(token, async (ctx) => {
        const duplicate = ctx.data.receipts.find(
          (receipt) => receipt.operationId === input.operationId,
        );
        if (duplicate) {
          const same =
            duplicate.orderId === input.orderId &&
            duplicate.periodId === input.periodId &&
            duplicate.amountCents === input.amountCents &&
            duplicate.receivedAt === input.receivedAt &&
            duplicate.channel === input.channel &&
            (duplicate.note ?? null) === note;
          if (!same) throw new AppError('CONFLICT', '同一操作编号的收款内容不同，已拒绝');
          return duplicate.id;
        }

        const order = mustFindOrder(ctx.data, input.orderId);
        if (order.cancelledAt !== null) {
          throw new AppError('ORDER_CANCELLED', '订单已作废，不能新增收款');
        }

        let ceiling: number;
        if (order.type === 'HOSTING') {
          if (!input.periodId) {
            throw new AppError('PERIOD_REQUIRED', '托管收款必须选择期次');
          }
          const period = ctx.data.hosting_periods.find((row) => row.id === input.periodId);
          if (!period || period.orderId !== order.id) {
            throw new AppError('PERIOD_REQUIRED', '收款的期次不属于该订单');
          }
          ceiling =
            period.priceCents -
            paidExcluding(ctx, (receipt) => receipt.periodId === period.id, null);
        } else {
          if (input.periodId) {
            throw new AppError('PERIOD_NOT_ALLOWED', '短期单收款不能指定期次');
          }
          ceiling =
            (order.priceCents ?? 0) -
            paidExcluding(ctx, (receipt) => receipt.orderId === order.id && receipt.periodId === null, null);
        }

        if (ceiling <= 0) {
          throw new AppError('AMOUNT_EXCEEDS_BALANCE', '该款项已结清');
        }
        if (input.amountCents > ceiling) {
          throw new AppError('AMOUNT_EXCEEDS_BALANCE', '收款金额超过未收余额');
        }
        if (order.paymentMode === 'ONE_TIME' && input.amountCents !== ceiling) {
          throw new AppError('AMOUNT_EXCEEDS_BALANCE', '一次性付款必须恰好结清当前款项');
        }

        const receiptId = newId();
        await ctx.table('receipts').add({
          id: receiptId,
          operationId: input.operationId,
          orderId: order.id,
          periodId: input.periodId,
          amountCents: input.amountCents,
          receivedAt: input.receivedAt,
          channel: input.channel,
          note,
          status: 'ACTIVE',
          replacedByReceiptId: null,
          createdAt: now(),
        });
        return receiptId;
      });
    },

    async amend(input: AmendCommand, token: DatasetToken): Promise<string> {
      validateAmount(input.amountCents);
      const note = input.channel === 'OTHER' ? optionalText(input.note, 200, '备注') : null;
      validateChannel(input.channel, note);
      const reason = optionalText(input.reason, 200, '更正原因');
      assertReceivedAt(input.receivedAt, now());

      return runtime.write(token, async (ctx) => {
        const existing = ctx.data.receipt_corrections.find(
          (correction) => correction.operationId === input.operationId,
        );
        if (existing) {
          const same =
            existing.receiptId === input.receiptId &&
            existing.kind === 'AMEND' &&
            existing.newAmountCents === input.amountCents &&
            existing.newReceivedAt === input.receivedAt &&
            existing.newChannel === input.channel &&
            (existing.newNote ?? null) === note &&
            (existing.reason ?? null) === reason;
          if (!same) throw new AppError('CONFLICT', '同一操作编号的更正内容不同，已拒绝');
          return existing.newReceiptId as string;
        }

        const original = ctx.data.receipts.find((receipt) => receipt.id === input.receiptId);
        if (!original) throw new AppError('NOT_FOUND', '原收款不存在');
        if (original.status !== 'ACTIVE') {
          throw new AppError('CONFLICT', '该收款已被更正或作废');
        }
        const order = mustFindOrder(ctx.data, original.orderId);
        const price =
          original.periodId === null
            ? (order.priceCents ?? 0)
            : (ctx.data.hosting_periods.find((period) => period.id === original.periodId)
                ?.priceCents ?? 0);
        const others = paidExcluding(ctx, (receipt) => {
          if (original.periodId === null) {
            return receipt.orderId === order.id && receipt.periodId === null;
          }
          return receipt.periodId === original.periodId;
        }, original.id);
        if (input.amountCents > price - others) {
          throw new AppError('AMOUNT_EXCEEDS_BALANCE', '更正后金额超过该款项应收');
        }

        const newReceiptId = newId();
        await ctx.table('receipts').put({
          ...original,
          status: 'REPLACED',
          replacedByReceiptId: newReceiptId,
        });
        await ctx.table('receipts').add({
          id: newReceiptId,
          operationId: `${input.operationId}:receipt`,
          orderId: original.orderId,
          periodId: original.periodId,
          amountCents: input.amountCents,
          receivedAt: input.receivedAt,
          channel: input.channel,
          note,
          status: 'ACTIVE',
          replacedByReceiptId: null,
          createdAt: now(),
        });
        await ctx.table('receipt_corrections').add({
          id: newId(),
          operationId: input.operationId,
          receiptId: original.id,
          kind: 'AMEND',
          reason,
          previousAmountCents: original.amountCents,
          previousReceivedAt: original.receivedAt,
          previousChannel: original.channel,
          previousNote: original.note,
          newReceiptId,
          newAmountCents: input.amountCents,
          newReceivedAt: input.receivedAt,
          newChannel: input.channel,
          newNote: note,
          createdAt: now(),
        });
        return newReceiptId;
      });
    },

    async void(input: VoidCommand, token: DatasetToken): Promise<string> {
      const reason = optionalText(input.reason, 200, '作废原因');
      return runtime.write(token, async (ctx) => {
        const existing = ctx.data.receipt_corrections.find(
          (correction) => correction.operationId === input.operationId,
        );
        if (existing) {
          const same =
            existing.receiptId === input.receiptId &&
            existing.kind === 'VOID' &&
            (existing.reason ?? null) === reason;
          if (!same) throw new AppError('CONFLICT', '同一操作编号的作废内容不同，已拒绝');
          return existing.id;
        }
        const original = ctx.data.receipts.find((receipt) => receipt.id === input.receiptId);
        if (!original) throw new AppError('NOT_FOUND', '原收款不存在');
        if (original.status !== 'ACTIVE') {
          throw new AppError('CONFLICT', '该收款已被更正或作废');
        }
        const correctionId = newId();
        await ctx.table('receipts').put({ ...original, status: 'VOIDED', replacedByReceiptId: null });
        await ctx.table('receipt_corrections').add({
          id: correctionId,
          operationId: input.operationId,
          receiptId: original.id,
          kind: 'VOID',
          reason,
          previousAmountCents: original.amountCents,
          previousReceivedAt: original.receivedAt,
          previousChannel: original.channel,
          previousNote: original.note,
          newReceiptId: null,
          newAmountCents: null,
          newReceivedAt: null,
          newChannel: null,
          newNote: null,
          createdAt: now(),
        });
        return correctionId;
      });
    },
  };
}
