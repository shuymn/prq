// Pages of a command's output (docs/design.md, Model context): a tool's result holds one page, and the next page can
// start anywhere, however far into the output or into one line it lies. The reader takes the output as it streams:
// what comes before the page is counted and dropped, never kept, and only the page itself is collected. The workspace
// reads every command's output through it, so a page never crosses to the session larger than it asked for.

// Where a page starts: a line of the output (from 1) and a character in it (from 0, in UTF-16 code units).
type PageStart = { line: number; char: number };

export type PageRequest = {
  start: PageStart;
  // The most characters the page takes: each line's text, its newline, and its number when numbered.
  capChars: number;
  // The lines are shown with their numbers (a tab after each), which the cap counts.
  numbered?: boolean;
  // A prefix removed from each line that starts with it (git grep's `<tree>:`); the cap counts what is left.
  stripPrefix?: string;
  // Count the lines after the page (`rest`), reading the output to its end.
  countRest?: boolean;
  // Check the output's first bytes for a NUL, as git tells a binary file (`binaryBytes`).
  detectBinary?: boolean;
};

export type Page = {
  start: PageStart;
  // The page's lines: the first from start.char of its line, the last cut short only when it is the only one.
  lines: string[];
  // Where the next page starts, or null when the output ended within this page.
  next: PageStart | null;
  // With countRest: the lines from next on, a line the page cut counted once.
  rest: number;
  // How many lines the output has, when the reader got to its end; null when it stopped at the page.
  lineCount: number | null;
  // With detectBinary: the output's size in bytes when it is binary; nothing is collected then.
  binaryBytes: number | null;
};

// git's own test for a binary file: a NUL among the first 8,000 bytes (FIRST_FEW_BYTES in git's xdiff-interface.c).
const BINARY_CHECK_BYTES = 8000;

// The smallest page worth asking for: the first line of a page always gets some of its characters.
export const MIN_PAGE_CHARS = 100;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

// The first `take` characters of text, one fewer when that would split a surrogate pair (never fewer than one pair).
export function cutAt(text: string, take: number): string {
  const end = take > 1 && isHighSurrogate(text.charCodeAt(take - 1)) ? take - 1 : take;
  return text.slice(0, end);
}

function lineExtra(request: Pick<PageRequest, "numbered">, line: number): number {
  return request.numbered === true ? String(line).length + 1 : 0;
}

// Collects a page while the output streams. Each part of a line and each line end comes in order; `done` says the
// page is complete and only counting goes on (for `rest`).
class PageCollector {
  readonly #request: PageRequest;
  readonly lines: string[] = [];
  next: PageStart | null = null;
  rest = 0;
  // The last line counted in rest.
  #countedLine = 0;
  // The line being read (from 1), whether any of it was read, and how many of its characters were.
  line = 1;
  inLine = false;
  #col = 0;
  // Whether the page is being collected, and the current line's characters so far (with its prefix, if any).
  #collecting: boolean;
  #current = "";
  #cost = 0;
  done = false;

  constructor(request: PageRequest) {
    this.#request = request;
    this.#collecting = request.start.line === 1 && request.start.char === 0;
  }

  part(text: string): void {
    this.inLine = true;
    if (this.done) {
      this.#countLine();
      return;
    }
    if (!this.#collecting) {
      const { line, char } = this.#request.start;
      if (this.line !== line) {
        return;
      }
      const skip = Math.min(text.length, char - this.#col);
      this.#col += skip;
      if (this.#col < char) {
        return;
      }
      this.#collecting = true;
      text = text.slice(skip);
    }
    this.#current += text;
    this.#checkFit();
  }

  lineEnd(): void {
    if (!this.done && !this.#collecting && this.line === this.#request.start.line) {
      // The start's line ends before its character: the page starts at the line's end.
      this.#collecting = true;
    }
    if (this.done) {
      this.#countLine();
    } else if (this.#collecting) {
      this.#checkFit();
      if (!this.done) {
        this.#cost += this.#shownLength() + 1 + lineExtra(this.#request, this.line);
        this.lines.push(this.#shown());
        this.#current = "";
      }
    }
    this.line += 1;
    this.inLine = false;
    this.#col = 0;
    if (!this.done && !this.#collecting && this.line === this.#request.start.line && this.#request.start.char === 0) {
      this.#collecting = true;
    }
  }

  // At the end of the output: the last line, when it has no newline after it.
  end(): void {
    if (!this.done && this.#collecting && this.inLine) {
      this.#checkFit();
      if (!this.done) {
        this.lines.push(this.#shown());
      }
    }
  }

  // A line counted after the page, once (at its first part, or at its end when it is empty).
  #countLine(): void {
    if (!this.inLine || this.#countedLine !== this.line) {
      this.#countedLine = this.line;
      this.rest += 1;
    }
  }

  #shownLength(): number {
    const prefix = this.#request.stripPrefix;
    if (prefix === undefined || prefix === "") {
      return this.#current.length;
    }
    if (this.#current.startsWith(prefix)) {
      return this.#current.length - prefix.length;
    }
    // A line that may still turn out to start with the prefix is counted as shown so far: none of it.
    return prefix.startsWith(this.#current) ? 0 : this.#current.length;
  }

  #shown(): string {
    const prefix = this.#request.stripPrefix;
    return prefix !== undefined && prefix !== "" && this.#current.startsWith(prefix)
      ? this.#current.slice(prefix.length)
      : this.#current;
  }

  // The current line no longer fits: the page ends before it, or, when it is the page's first line, inside it.
  #checkFit(): void {
    const extra = lineExtra(this.#request, this.line);
    if (this.#cost + extra + this.#shownLength() + 1 <= this.#request.capChars) {
      return;
    }
    this.done = true;
    this.#countedLine = this.line;
    this.rest = 1;
    if (this.lines.length > 0) {
      this.next = { line: this.line, char: 0 };
      return;
    }
    const shown = this.#shown();
    const kept = cutAt(shown, Math.max(1, this.#request.capChars - extra - 1));
    this.lines.push(kept);
    // Where the next page starts in the line as the output has it, before any prefix was removed.
    const removed = this.#current.length - shown.length;
    const lineStart = this.line === this.#request.start.line ? this.#request.start.char : 0;
    this.next = { line: this.line, char: lineStart + removed + kept.length };
  }
}

// Reads one page of an output stream (a command's stdout), as the request describes it. The stream is cancelled once
// the page is complete, unless the request needs the rest counted or the binary check is still open; whatever reads
// from a process kills it then.
export async function pageLines(output: ReadableStream<Uint8Array>, request: PageRequest): Promise<Page> {
  const collector = new PageCollector(request);
  const decoder = new TextDecoder();
  const reader = output.getReader();
  let bytes = 0;
  let binary = false;
  let ended = false;
  const feed = (text: string): void => {
    let from = 0;
    while (from < text.length) {
      const newline = text.indexOf("\n", from);
      const end = newline === -1 ? text.length : newline;
      if (end > from) {
        collector.part(text.slice(from, end));
      }
      if (newline === -1) {
        return;
      }
      collector.lineEnd();
      from = newline + 1;
    }
  };
  try {
    for (;;) {
      const needBinaryCheck = request.detectBinary === true && !binary && bytes < BINARY_CHECK_BYTES;
      if (collector.done && request.countRest !== true && !needBinaryCheck && !binary) {
        break;
      }
      const read = await reader.read();
      if (read.done) {
        ended = true;
        break;
      }
      const chunk = read.value;
      if (request.detectBinary === true && !binary && bytes < BINARY_CHECK_BYTES) {
        binary = chunk.subarray(0, BINARY_CHECK_BYTES - bytes).includes(0);
      }
      bytes += chunk.byteLength;
      if (!binary) {
        feed(decoder.decode(chunk, { stream: true }));
      }
    }
  } finally {
    if (!ended) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  if (binary) {
    return { start: request.start, lines: [], next: null, rest: 0, lineCount: null, binaryBytes: bytes };
  }
  feed(decoder.decode());
  collector.end();
  const lineCount = ended ? (collector.inLine ? collector.line : collector.line - 1) : null;
  return {
    start: request.start,
    lines: collector.lines,
    next: collector.next,
    rest: collector.rest,
    lineCount,
    binaryBytes: null,
  };
}

// A page cut again to a smaller cap, by the same rule: whole lines while they fit, the first line cut inside when it
// alone does not. The tool's result is cut to the room the context has left when it completes. A page read with a
// prefix removed gets a next start that does not count the prefix; such a page (grep's) is not continued from it.
export function fitPage(page: Page, capChars: number, numbered: boolean): Page {
  let cost = 0;
  for (const [index, text] of page.lines.entries()) {
    const line = page.start.line + index;
    const extra = lineExtra({ numbered }, line);
    if (cost + extra + text.length + 1 <= capChars) {
      cost += extra + text.length + 1;
      continue;
    }
    const dropped = page.lines.length - index;
    if (index > 0) {
      return {
        ...page,
        lines: page.lines.slice(0, index),
        next: { line, char: 0 },
        rest: page.rest + dropped,
      };
    }
    const kept = cutAt(text, Math.max(1, capChars - extra - 1));
    // The page's only line, cut already, is in its rest; any other first line joins it there.
    const cutBefore = page.lines.length === 1 && page.next !== null && page.next.line === line;
    return {
      ...page,
      lines: [kept],
      next: { line, char: page.start.char + kept.length },
      rest: page.rest + dropped - (cutBefore ? 1 : 0),
    };
  }
  return page;
}
