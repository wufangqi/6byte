/** One change inside a single editor transaction, in that transaction's original coordinates. */
export interface DocEdit {
  from: number;
  to: number;
  insert: number;
}
