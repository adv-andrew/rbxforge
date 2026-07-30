const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses a canonical Roblox DataModel path into its instance-name segments. */
export function parseDataModelPath(input: string): readonly string[] {
  if (!input.startsWith("game") || !isPathBoundary(input[4])) {
    throw new Error("DataModel path must start with game");
  }

  const segments = ["game"];
  let position = 4;

  while (position < input.length) {
    const next = input[position];
    if (next === ".") {
      position += 1;
      const start = position;

      if (!isIdentifierStart(input[position])) {
        throw new Error("DataModel path contains an invalid identifier segment");
      }

      position += 1;
      while (isIdentifierPart(input[position])) {
        position += 1;
      }
      segments.push(input.slice(start, position));
      continue;
    }

    if (next === "[") {
      const result = parseQuotedSegment(input, position);
      segments.push(result.segment);
      position = result.nextPosition;
      continue;
    }

    throw new Error("DataModel path contains an unsupported segment");
  }

  return segments;
}

/** Formats DataModel segments using dot notation only where it is unambiguous. */
export function formatDataModelPath(segments: readonly string[]): string {
  if (segments[0] !== "game") {
    throw new Error("DataModel path must start with game");
  }
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new Error("DataModel path segments must not be empty");
  }

  return segments.reduce((path, segment, index) => {
    if (index === 0) {
      return segment;
    }

    return IDENTIFIER.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
  }, "");
}

/** Returns a path's canonical parent, if the path is not the game root. */
export function parentDataModelPath(input: string): string | undefined {
  const segments = parseDataModelPath(input);
  return segments.length === 1 ? undefined : formatDataModelPath(segments.slice(0, -1));
}

/** Appends one instance name to a parent DataModel path. */
export function joinDataModelPath(parent: string, child: string): string {
  return formatDataModelPath([...parseDataModelPath(parent), child]);
}

function isPathBoundary(value: string | undefined): boolean {
  return value === undefined || value === "." || value === "[";
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z_]$/.test(value);
}

function isIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9_]$/.test(value);
}

function parseQuotedSegment(input: string, openingBracket: number): { segment: string; nextPosition: number } {
  const stringStart = openingBracket + 1;
  if (input[stringStart] !== '"') {
    throw new Error("DataModel path contains an unsupported bracket expression");
  }

  let position = stringStart + 1;
  while (position < input.length) {
    if (input[position] === "\\") {
      position += 2;
      continue;
    }
    if (input[position] === '"') {
      break;
    }
    position += 1;
  }

  if (position >= input.length || input[position] !== '"' || input[position + 1] !== "]") {
    throw new Error("DataModel path contains an unclosed quoted segment");
  }

  const token = input.slice(stringStart, position + 1);
  let segment: unknown;
  try {
    segment = JSON.parse(token);
  } catch {
    throw new Error("DataModel path contains an invalid quoted segment");
  }

  if (typeof segment !== "string" || segment.length === 0) {
    throw new Error("DataModel path segments must not be empty");
  }

  return { segment, nextPosition: position + 2 };
}
