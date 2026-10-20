export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  now?: () => string;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CREDENTIAL_PATTERNS: RegExp[] = [
  /ck_[A-Za-z0-9]+/g,
  /cs_[A-Za-z0-9]+/g,
  /sk_[A-Za-z0-9]+/g,
  /umk_[A-Za-z0-9_-]+/g,
  /Basic\s+[A-Za-z0-9+/=]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
];

export function redactLine(line: string): string {
  let redacted = line;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

function defaultSink(): LogSink {
  return {
    write(line: string): void {
      process.stdout.write(`${line}\n`);
    },
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minWeight = LEVEL_WEIGHT[options.level ?? "info"];
  const sink = options.sink ?? defaultSink();
  const now = options.now ?? (() => new Date().toISOString());

  function emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < minWeight) {
      return;
    }
    const record: Record<string, unknown> = {
      ts: now(),
      level,
      event,
      ...(fields ?? {}),
    };
    sink.write(redactLine(JSON.stringify(record)));
  }

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
