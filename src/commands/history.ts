/**
 * Snapshot undo/redo over immutable states. `coalesce` lets a burst of edits to the same thing
 * (typing in a text overlay, nudging with arrow keys) collapse into a single undo step.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey: string | null = null;

  constructor(private current: T, private readonly limit = 200) {}

  get present(): T { return this.current; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /** Records a new state. Returns false (and records nothing) when the state is unchanged. */
  commit(next: T, coalesce?: string): boolean {
    if (next === this.current) return false;
    if (coalesce && coalesce === this.lastKey) {
      this.current = next;
      this.future = [];
      return true;
    }
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = next;
    this.future = [];
    this.lastKey = coalesce ?? null;
    return true;
  }

  /** Ends any coalescing run so the next commit starts a fresh undo step. */
  seal(): void { this.lastKey = null; }

  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.current);
    this.current = prev;
    this.lastKey = null;
    return prev;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.current);
    this.current = next;
    this.lastKey = null;
    return next;
  }

  reset(state: T): void {
    this.past = [];
    this.future = [];
    this.current = state;
    this.lastKey = null;
  }
}
