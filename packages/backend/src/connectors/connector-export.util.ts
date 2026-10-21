import { toPublicConnector } from './connector-secrets.util';

/** Version written into every export envelope (export-all and :id/export). */
export const EXPORT_FORMAT_VERSION = '1.0';

/**
 * One connector as it appears in an export file. authConfig is never
 * exported. Secret env vars and headers are kept only when `includeSecrets`
 * is set (admins); otherwise they are left empty and named in
 * `maskedEnvVars` / `maskedHeaders`.
 */
export function toExportEntry(c: any, includeSecrets: boolean) {
  const masked = includeSecrets ? null : toPublicConnector(c);
  return {
    name: c.name,
    type: c.type,
    baseUrl: c.baseUrl,
    isActive: c.isActive,
    authType: c.authType,
    specUrl: c.specUrl,
    headers: masked ? masked.headers : c.headers,
    config: c.config,
    envVars: masked ? masked.envVars : c.envVars,
    ...(masked
      ? { maskedEnvVars: masked.maskedEnvVars, maskedHeaders: masked.maskedHeaders }
      : {}),
    tools: (c.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
      isEnabled: t.isEnabled,
      parameters: t.parameters,
      endpointMapping: t.endpointMapping,
      responseMapping: t.responseMapping,
      outputSchema: t.outputSchema,
    })),
  };
}

/** The envelope shared by export-all and the single-connector export. */
export function toExportEnvelope(connectors: any[], includeSecrets: boolean) {
  return {
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    secretsIncluded: includeSecrets,
    connectors: connectors.map((c) => toExportEntry(c, includeSecrets)),
  };
}
