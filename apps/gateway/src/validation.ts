import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

export type ValidationOutcome =
  | { ok: true }
  | { ok: false; issues: string[] };

export interface SchemaValidator {
  validate(qualifiedName: string, schema: Record<string, unknown>, data: unknown): ValidationOutcome;
}

interface CacheEntry {
  schemaJson: string;
  validate: ValidateFunction;
}

function formatIssue(error: ErrorObject): string {
  const path = error.instancePath === "" ? "/" : error.instancePath;
  return `${path} ${error.message ?? "is invalid"}`;
}

export function createSchemaValidator(): SchemaValidator {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const cache = new Map<string, CacheEntry>();

  return {
    validate(qualifiedName, schema, data): ValidationOutcome {
      const schemaJson = JSON.stringify(schema);
      let entry = cache.get(qualifiedName);
      if (entry === undefined || entry.schemaJson !== schemaJson) {
        const candidate: Record<string, unknown> = { ...schema };
        delete candidate.$schema;
        const compiled = ajv.compile(candidate);
        entry = { schemaJson, validate: compiled };
        cache.set(qualifiedName, entry);
      }
      if (entry.validate(data)) {
        return { ok: true };
      }
      const issues = (entry.validate.errors ?? []).map(formatIssue);
      return {
        ok: false,
        issues: issues.length > 0 ? issues : ["arguments do not match the tool schema"],
      };
    },
  };
}
