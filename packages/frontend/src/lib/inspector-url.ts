export const INSPECTOR_BASE_URL = 'http://localhost:6274/';
/**
 * Builds a link that opens the MCP Inspector pointed at this server.
 * Only the server URL goes in the link: never API keys or tokens.
 */
export function inspectorUrl(endpointUrl: string): string {
  return `${INSPECTOR_BASE_URL}?transport=streamable-http&serverUrl=${encodeURIComponent(endpointUrl)}`;
}
