import { coerceErrorMessage, extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";

const STORAGE_ERRORS = [
  ["SQLITE_BUSY", "database is locked", 5],
  ["SQLITE_LOCKED", "database table is locked", 6],
  ["SQLITE_READONLY", "attempt to write a readonly database", 8],
  ["SQLITE_IOERR", "disk I/O error", 10],
  ["SQLITE_FULL", "database or disk is full", 13],
  ["transcript_writer_fenced", "session writer claim changed before transcript persistence", -1],
] as const;
export type GatewayStorageFailure = (typeof STORAGE_ERRORS)[number][0];

/** Classify native errors before flattening; legacy rows require exact known messages. */
export function classifyGatewayStorageFailure(error: unknown): GatewayStorageFailure | undefined {
  const fields = typeof error === "string" ? { message: error } : isRecord(error) ? error : {};
  const code = fields.errorCode ?? fields.code;
  const nativeCode = fields.errcode;
  const primaryCode =
    typeof nativeCode === "number" && Number.isInteger(nativeCode) && nativeCode >= 0
      ? nativeCode & 0xff
      : undefined;
  const typed = STORAGE_ERRORS.find(
    ([name, , number]) =>
      primaryCode === number ||
      (typeof code === "string" &&
        (code === name || (name.startsWith("SQLITE_") && code.startsWith(`${name}_`)))),
  );
  return (typed ??
    STORAGE_ERRORS.find(([, message]) =>
      [fields.errstr, fields.errorMessage, fields.message].some(
        (value) => typeof value === "string" && value.trim() === message,
      ),
    ))?.[0];
}

/** Bounded, owner-generated names for the read-only inspection operations that can fail. */
const SQLITE_INSPECTION_OPERATIONS = {
  coordinator: "acquiring its state-handles coordinator",
  source: "opening the source database",
  snapshot: "creating its private snapshot",
} as const;
type SqliteInspectionOperation = keyof typeof SQLITE_INSPECTION_OPERATIONS;

const SQLITE_INSPECTION_OPERATION_MARKER = Symbol.for("openclaw.sqliteInspectionOperation");
const SQLITE_INSPECTION_OPERATION_DEPTH = 8;

function isSqliteInspectionOperation(value: string): value is SqliteInspectionOperation {
  return Object.hasOwn(SQLITE_INSPECTION_OPERATIONS, value);
}

function readSqliteInspectionOperation(value: unknown): SqliteInspectionOperation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const operation = Reflect.get(value, SQLITE_INSPECTION_OPERATION_MARKER);
  return typeof operation === "string" && isSqliteInspectionOperation(operation)
    ? operation
    : undefined;
}

/**
 * Tag the operation that was in flight without replacing the error, so existing
 * `instanceof` handling, native codes, and messages stay intact. The innermost
 * tag wins: a wrapper must not relabel the operation that actually failed.
 */
function markSqliteInspectionOperation(error: unknown, operation: SqliteInspectionOperation): void {
  if (
    error === null ||
    typeof error !== "object" ||
    readSqliteInspectionOperation(error) !== undefined
  ) {
    return;
  }
  Object.defineProperty(error, SQLITE_INSPECTION_OPERATION_MARKER, {
    value: operation,
    enumerable: false,
    configurable: true,
  });
}

/** Run a synchronous inspection operation and tag its failure with that operation. */
export function withSqliteInspectionOperation<T>(
  operation: SqliteInspectionOperation,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    markSqliteInspectionOperation(error, operation);
    throw error;
  }
}

/** Run an awaited inspection operation and tag its failure with that operation. */
export async function withSqliteInspectionOperationAsync<T>(
  operation: SqliteInspectionOperation,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    markSqliteInspectionOperation(error, operation);
    throw error;
  }
}

/** Resolve the tagged operation across the bounded cause chain. */
function resolveSqliteInspectionOperation(error: unknown): SqliteInspectionOperation | undefined {
  for (
    let current = error, depth = 0;
    depth < SQLITE_INSPECTION_OPERATION_DEPTH && isRecord(current);
    depth += 1
  ) {
    const operation = readSqliteInspectionOperation(current);
    if (operation !== undefined) {
      return operation;
    }
    current = Reflect.get(current, "cause");
  }
  return undefined;
}

/**
 * Render a read-only inspection failure with its failing operation. Only fixed
 * owner-generated wording is added; the native message and bounded codes are
 * preserved and no cause prose, path, or metadata is serialized.
 */
export function formatSqliteReadOnlyInspectionFailure(error: unknown): string {
  const details = `${coerceErrorMessage(error)}${formatSqliteErrorCodeSuffix(error)}`;
  const operation = resolveSqliteInspectionOperation(error);
  return operation === undefined
    ? details
    : `failed while ${SQLITE_INSPECTION_OPERATIONS[operation]}: ${details}`;
}

export function formatSqliteErrorCodeSuffix(error: unknown): string {
  const details = new Set<string>();
  // Preserve native codes through wrappers without exposing cause prose or metadata.
  // The depth cap also bounds cyclic causes; Node's SQLite errcode is a signed int.
  for (let current = error, depth = 0; depth < 8 && isRecord(current); depth += 1) {
    const code = extractErrorCode(current);
    if (code && /^[A-Z0-9_]{1,64}$/u.test(code)) {
      details.add(`code=${code}`);
    }
    const { errcode } = current;
    if (
      typeof errcode === "number" &&
      Number.isInteger(errcode) &&
      errcode >= 0 &&
      errcode <= 0x7fff_ffff
    ) {
      details.add(`errcode=${errcode}`);
    }
    current = current.cause;
  }
  return details.size > 0 ? ` (${[...details].join(", ")})` : "";
}

// Native snapshot coordination needs classification without loading transaction logging.
const SQLITE_LOCK_ERROR_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
// Node reports SQLite failures with a generic string code and the extended
// SQLite result in `errcode`; the low byte identifies BUSY or LOCKED.
const SQLITE_BUSY_RESULT_CODE = 5;
const SQLITE_LOCKED_RESULT_CODE = 6;
const SQLITE_CORRUPT_RESULT_CODE = 11;
const SQLITE_NOTADB_RESULT_CODE = 26;
const SQLITE_PRIMARY_RESULT_CODE_MASK = 0xff;

export function sqliteErrorCode(error: unknown): string | undefined {
  const code = asOptionalObjectRecord(error)?.code;
  return typeof code === "string" ? code : undefined;
}

export function sqliteExtendedResultCode(error: unknown): number | undefined {
  const errcode = asOptionalObjectRecord(error)?.errcode;
  return typeof errcode === "number" && Number.isInteger(errcode) ? errcode : undefined;
}

export function sqlitePrimaryResultCode(error: unknown): number | undefined {
  const errcode = sqliteExtendedResultCode(error);
  return errcode === undefined ? undefined : errcode & SQLITE_PRIMARY_RESULT_CODE_MASK;
}

export function isSqliteLockError(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  if (code !== undefined && SQLITE_LOCK_ERROR_CODES.has(code)) {
    return true;
  }
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_BUSY_RESULT_CODE || primaryCode === SQLITE_LOCKED_RESULT_CODE;
}

/** Report proven file damage (corrupt page or non-database header), not transient failure. */
export function isSqliteCorruptionError(error: unknown): boolean {
  const primaryCode = sqlitePrimaryResultCode(error);
  return primaryCode === SQLITE_CORRUPT_RESULT_CODE || primaryCode === SQLITE_NOTADB_RESULT_CODE;
}
