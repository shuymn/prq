// What a process started, each with its ending, so that one stop undoes all of it: the endings run last first, each
// once, and every one runs even when another throws.
export class Endings {
  readonly #endings: (() => Promise<void>)[] = [];

  add(ending: () => Promise<void>): void {
    this.#endings.push(ending);
  }

  // Runs the endings added so far, last first; returns what they threw.
  async run(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const ending of this.#endings.splice(0).toReversed()) {
      try {
        await ending();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}
