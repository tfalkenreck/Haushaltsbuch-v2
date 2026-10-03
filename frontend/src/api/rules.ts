import { apiRequest, query } from './client';

export type RuleField = 'counterparty' | 'purpose';
export type PatternType = 'contains' | 'wildcard';

export interface Rule {
  id: number;
  field: RuleField;
  patternType: PatternType;
  pattern: string;
  categoryId: number;
  categoryPath: string;
  categoryActive: boolean;
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  matchCount: number;
  assignedCount: number;
}

export interface RuleInput {
  field: RuleField;
  patternType: PatternType;
  pattern: string;
  categoryId: number;
  priority: number;
  active?: boolean;
}

export interface PatternPreview {
  matchCount: number;
  uncategorizedCount: number;
  samples: { id: number; counterparty: string; purpose: string }[];
}

export interface RuleSuggestion {
  field: RuleField;
  patternType: PatternType;
  pattern: string;
  categoryId: number;
  categoryPath: string;
  priority: number;
  existingRuleId: number | null;
  outranks: { id: number; pattern: string; categoryPath: string; priority: number }[];
  uncategorizedMatches: number;
  otherRuleMatches: number;
}

export const fetchRules = () => apiRequest<Rule[]>('GET', '/rules');
export const createRule = (input: RuleInput) => apiRequest<Rule>('POST', '/rules', input);
export const updateRule = (id: number, patch: Partial<RuleInput>) => apiRequest<Rule>('PATCH', `/rules/${id}`, patch);
export const deleteRule = (id: number, unassign: boolean) =>
  apiRequest<{ unassigned: number }>('DELETE', `/rules/${id}${query({ unassign: unassign ? 'true' : undefined })}`);
export const previewPattern = (input: { field: RuleField; patternType: PatternType; pattern: string }) =>
  apiRequest<PatternPreview>('POST', '/rules/preview', input);
export const applyAllRules = () => apiRequest<{ categorized: number }>('POST', '/rules/apply');
export const applyRule = (id: number) => apiRequest<{ categorized: number }>('POST', `/rules/${id}/apply`);

export interface ReassignCandidate {
  id: number;
  accountName: string;
  bookingDate: string;
  amountCents: number;
  counterparty: string;
  purpose: string;
  categoryPath: string;
  rulePattern: string | null;
}

/** „Auch diese umstellen“ – Vorschau, bevor die Regel gespeichert ist. */
export const previewReassign = (input: {
  field: RuleField;
  patternType: PatternType;
  pattern: string;
  categoryId: number;
  priority: number;
  ruleId: number | null;
}) => apiRequest<ReassignCandidate[]>('POST', '/rules/reassign-preview', input);

/** Ausgewählte, per Regel einsortierte Buchungen umstellen (nie von Hand gesetzte). */
export const reassignToRule = (ruleId: number, transactionIds: number[]) =>
  apiRequest<{ reassigned: number }>('POST', `/rules/${ruleId}/reassign`, { transactionIds });
