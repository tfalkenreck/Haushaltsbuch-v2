import { apiRequest } from './client';

export type Bucket = 'need' | 'want' | 'save';

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  path: string;
  bucket: Bucket | null;
  inheritBucket: boolean;
  effectiveBucket: Bucket | null;
  active: boolean;
  transactionCount: number;
  ruleCount: number;
  childCount: number;
}

export interface CategoryInput {
  name: string;
  parentId?: number | null;
  bucket?: Bucket | null;
  inheritBucket?: boolean;
}

export type CategoryPatch = Partial<CategoryInput> & { active?: boolean };

export const fetchCategories = () => apiRequest<Category[]>('GET', '/categories');
export const createCategory = (input: CategoryInput) => apiRequest<Category>('POST', '/categories', input);
export const updateCategory = (id: number, patch: CategoryPatch) => apiRequest<Category>('PATCH', `/categories/${id}`, patch);
export const deleteCategory = (id: number) => apiRequest<null>('DELETE', `/categories/${id}`);
