import { apiRequest, apiUpload, query } from './client';

export interface SkippedLine {
  line: number;
  reason: string;
}

export interface ImportResult {
  batchId: number | null;
  accountId: number;
  bankAdapter: string;
  fileName: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowsTotal: number;
  imported: number;
  categorized: number;
  duplicates: number;
  /** Vorhandene Buchungen, bei denen fehlende Angaben nachgetragen wurden. */
  backfilled: number;
  transfersDetected: number;
  otherAccount: number;
  pending: SkippedLine[];
  ignored: SkippedLine[];
  warnings: string[];
}

export interface ImportBatch {
  id: number;
  accountId: number;
  accountName: string;
  bankAdapter: string;
  fileName: string;
  importedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowsTotal: number;
  rowsImported: number;
  rowsDuplicate: number;
  rowsSkipped: number;
  balanceCents: number | null;
  balanceDate: string | null;
  transactionCount: number;
  needsReimport: boolean;
}

export interface UndoResult {
  batchId: number;
  deletedTransactions: number;
  warnings: string[];
}

export interface Period {
  start: string;
  end: string;
}

export interface AccountCoverage {
  accountId: number;
  periods: Period[];
  gaps: Period[];
  months: { month: string; status: 'complete' | 'partial' | 'missing'; transactionCount: number }[];
}

export const uploadImport = (accountId: number, file: File, periodStart: string, periodEnd: string) =>
  apiUpload<ImportResult>(
    `/accounts/${accountId}/imports${query({ fileName: file.name, periodStart, periodEnd })}`,
    file,
  );

export const fetchImports = (accountId?: number) => apiRequest<ImportBatch[]>('GET', `/imports${query({ accountId })}`);

export const undoImport = (batchId: number) => apiRequest<UndoResult>('DELETE', `/imports/${batchId}`);

export const fetchCoverage = (accountId: number) => apiRequest<AccountCoverage>('GET', `/accounts/${accountId}/coverage`);
