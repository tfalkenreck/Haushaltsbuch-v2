import type { Bucket } from '../api/categories';
import { BUCKET_LABELS, bucketLabel } from '../lib/labels';

/** Wert der Auswahl: ein Bucket, „keiner“ oder (nur Unterkategorien) „von der Elternkategorie erben“. */
export type BucketChoice = Bucket | 'none' | 'inherit';

interface Props {
  value: BucketChoice;
  onChange: (choice: BucketChoice) => void;
  /** Gesetzt bei Unterkategorien: Bucket der Elternkategorie (für „erben“). */
  parentBucket?: Bucket | null | undefined;
  disabled?: boolean;
}

export function BucketSelect({ value, onChange, parentBucket, disabled }: Props) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as BucketChoice)} disabled={disabled}>
      {parentBucket !== undefined && <option value="inherit">erbt: {bucketLabel(parentBucket)}</option>}
      {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
        <option key={b} value={b}>
          {BUCKET_LABELS[b]}
        </option>
      ))}
      <option value="none">keiner (nicht in 50/30/20)</option>
    </select>
  );
}

/** Auswahl → Felder für die API. */
export function bucketFields(choice: BucketChoice): { bucket?: Bucket | null; inheritBucket: boolean } {
  if (choice === 'inherit') return { inheritBucket: true };
  return { bucket: choice === 'none' ? null : choice, inheritBucket: false };
}

export function bucketChoiceOf(category: { inheritBucket: boolean; bucket: Bucket | null }): BucketChoice {
  if (category.inheritBucket) return 'inherit';
  return category.bucket ?? 'none';
}
