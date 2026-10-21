import * as yaml from 'js-yaml';
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

export type ExportFormat = 'json' | 'yaml';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['json', 'yaml'];

/**
 * Serialise an export envelope. YAML uses the core schema, so a timestamp
 * such as `exportedAt` reads back as a string, and never emits anchors.
 */
export function serializeExport(data: unknown, format: ExportFormat): string {
  if (format === 'yaml') {
    return yaml.dump(data, { schema: yaml.CORE_SCHEMA, noRefs: true, lineWidth: -1 });
  }
  return JSON.stringify(data, null, 2);
}

/** `<slug>.anythingmcp.<ext>`, ASCII only, safe inside a quoted header value. */
export function exportFileName(connectorName: string, format: ExportFormat): string {
  const slug =
    String(connectorName ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'connector';
  return `${slug}.anythingmcp.${format === 'yaml' ? 'yaml' : 'json'}`;
}
