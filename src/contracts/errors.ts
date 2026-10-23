export type AppErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STALE_DATASET'
  | 'ARCHIVED_OWNER'
  | 'ARCHIVED_ACCOUNT'
  | 'ARCHIVED_ORDER'
  | 'ARCHIVE_GUARD'
  | 'SCOPE_NOT_ALLOWED'
  | 'SESSION_INDEX_EXHAUSTED'
  | 'SUPERSEDED_EVENT'
  | 'OUT_OF_SERVICE_RANGE'
  | 'DUPLICATE_NUMBER'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'AMOUNT_EXCEEDS_BALANCE'
  | 'PERIOD_REQUIRED'
  | 'PERIOD_NOT_ALLOWED'
  | 'PERIOD_OVERLAP'
  | 'ORDER_CANCELLED'
  | 'ORDER_HAS_RECORDS'
  | 'BACKUP_FORMAT'
  | 'BACKUP_LIMIT'
  | 'BACKUP_CHECKSUM'
  | 'BACKUP_PASSWORD'
  | 'BACKUP_VALIDATION'
  | 'STORAGE_UNAVAILABLE'
  | 'LOCK_UNAVAILABLE'
  | 'CANCELLED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function toAppError(value: unknown, fallback = '操作失败'): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error && value.message) return new AppError('INTERNAL', value.message);
  return new AppError('INTERNAL', fallback);
}
