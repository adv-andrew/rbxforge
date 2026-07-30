import { Socket } from "node:net";

const SENSITIVE_CREDENTIAL_KEY =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|CREDENTIALS?|PASSWORD)(?:_|$)/i;

let boundaryInstalled = false;

export async function withFailClosedExecutionBoundary<T>(run: () => T | Promise<T>): Promise<T> {
  if (boundaryInstalled) throw new Error("Integrated execution boundary cannot be nested.");
  boundaryInstalled = true;

  const violations: string[] = [];
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const socketConnectDescriptor = Object.getOwnPropertyDescriptor(Socket.prototype, "connect");
  const environmentDescriptor = Object.getOwnPropertyDescriptor(process, "env");
  const environment = process.env;

  const reject = (message: string): never => {
    violations.push(message);
    throw new Error(message);
  };

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    enumerable: fetchDescriptor?.enumerable ?? true,
    writable: true,
    value: (input: unknown) => reject(`Integrated execution attempted forbidden global fetch: ${describeFetch(input)}`),
  });
  Object.defineProperty(Socket.prototype, "connect", {
    configurable: true,
    enumerable: socketConnectDescriptor?.enumerable ?? false,
    writable: true,
    value: (...args: unknown[]) =>
      reject(`Integrated execution attempted forbidden socket connect: ${describeSocketTarget(args)}`),
  });
  Object.defineProperty(process, "env", {
    configurable: environmentDescriptor?.configurable ?? true,
    enumerable: environmentDescriptor?.enumerable ?? true,
    writable: environmentDescriptor?.writable ?? true,
    value: new Proxy(environment, {
      get(target, property, receiver) {
        rejectCredentialProperty(property, reject);
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        rejectCredentialProperty(property, reject);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has(target, property) {
        rejectCredentialProperty(property, reject);
        return Reflect.has(target, property);
      },
    }),
  });

  try {
    const result = await run();
    if (violations.length > 0) {
      throw new Error(`Integrated execution boundary observed forbidden effects: ${violations.join("; ")}`);
    }
    return result;
  } finally {
    restoreProperty(globalThis, "fetch", fetchDescriptor);
    restoreProperty(Socket.prototype, "connect", socketConnectDescriptor);
    restoreProperty(process, "env", environmentDescriptor);
    boundaryInstalled = false;
  }
}

function rejectCredentialProperty(property: string | symbol, reject: (message: string) => never): void {
  if (typeof property === "string" && SENSITIVE_CREDENTIAL_KEY.test(property)) {
    reject(`Integrated execution attempted forbidden credential environment lookup: ${property}`);
  }
}

function describeFetch(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function describeSocketTarget(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? args[1] : "localhost";
    return `${host}:${first}`;
  }
  if (typeof first === "string") return first;
  if (Array.isArray(first)) return describeSocketTarget(first);
  if (first !== null && typeof first === "object") {
    const options = first as {
      readonly host?: unknown;
      readonly hostname?: unknown;
      readonly path?: unknown;
      readonly port?: unknown;
    };
    if (typeof options.path === "string") return options.path;
    const host =
      typeof options.host === "string"
        ? options.host
        : typeof options.hostname === "string"
          ? options.hostname
          : "localhost";
    return `${host}:${String(options.port ?? "unknown")}`;
  }
  return "unknown";
}

function restoreProperty(target: object, property: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, property);
  } else {
    Object.defineProperty(target, property, descriptor);
  }
}
