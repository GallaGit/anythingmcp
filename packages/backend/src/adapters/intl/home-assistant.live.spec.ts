import axios from 'axios';
import * as adapter from './home-assistant.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Home Assistant adapter (read-only):
 *
 *   1. Static: always runs. Pins Bearer auth with a long-lived access token on
 *      the instance URL the user enters, GET-only tools, and every tool's URL
 *      and query through the real RestEngine, checked against the Home
 *      Assistant REST API docs
 *      (https://contributors.home-assistant.io/core/internals/rest-api/, read
 *      26 Oct 2026).
 *
 *   2. Live: skipped unless RUN_HOME_ASSISTANT_LIVE=1 with HOME_ASSISTANT_URL
 *      and HOME_ASSISTANT_TOKEN set. Calls /api/config and /api/states.
 *      A local test instance: Home Assistant Container with `demo:` in
 *      configuration.yaml.
 *
 *        RUN_HOME_ASSISTANT_LIVE=1 HOME_ASSISTANT_URL=http://localhost:8123 \
 *        HOME_ASSISTANT_TOKEN=... npx jest src/adapters/intl/home-assistant
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { description?: string; pattern?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

// Built at runtime so no literal looks like a real credential.
const FAKE_TOKEN = 'eyJ' + 'x'.repeat(40) + '.' + 'y'.repeat(20);
const ENV: Record<string, string> = { HOME_ASSISTANT_URL: 'https://home.example.com', HOME_ASSISTANT_TOKEN: FAKE_TOKEN };
const API = 'https://home.example.com/api';

const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => {
  const req = sent();
  return req.paramsSerializer ? decodeURIComponent(req.paramsSerializer(req.params)) : '';
};

describe('home-assistant adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('sends the long-lived token as Bearer to {{HOME_ASSISTANT_URL}}/api', () => {
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('home-assistant');
    expect(a.docsUrl).toBe('https://contributors.home-assistant.io/core/internals/rest-api/');
    expect(a.connector.baseUrl).toBe('{{HOME_ASSISTANT_URL}}/api');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{HOME_ASSISTANT_TOKEN}}' });
    expect(a.connector.healthcheckPath).toBe('/');
    expect(a.probe.tool).toBe('home_assistant_get_config');
    expect(a.requiredEnvVars).toEqual(['HOME_ASSISTANT_URL', 'HOME_ASSISTANT_TOKEN']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.HOME_ASSISTANT_URL).toMatchObject({ kind: 'address', secret: false });
    expect(meta.HOME_ASSISTANT_TOKEN).toMatchObject({ kind: 'credential', secret: true });
  });

  it('accepts instance URLs without a trailing slash, and a bare token', () => {
    const url = new RegExp(a.envVarMeta.HOME_ASSISTANT_URL.pattern!);
    for (const ok of ['https://home.example.com', 'http://192.168.1.10:8123', 'http://homeassistant.local:8123', 'https://example.com/ha']) expect(url.test(ok)).toBe(true);
    for (const bad of ['home.example.com', 'https://home.example.com/', 'http://192.168.1.10:8123/api/']) expect(url.test(bad)).toBe(false);
    const token = new RegExp(a.envVarMeta.HOME_ASSISTANT_TOKEN.pattern!);
    expect(token.test(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', `Bearer ${FAKE_TOKEN}`, 'short']) expect(token.test(bad)).toBe(false);
  });

  it('is strictly read-only: seven GET tools, no POST/PUT/PATCH/DELETE, no services', () => {
    expect(a.tools).toHaveLength(7);
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations }))
        .toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.endpointMapping.path).not.toMatch(/services|template|events|camera_proxy|stream|error_log|intent|conversation/);
    }
  });

  it('prefixes every tool and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    for (const name of mine) expect(name).toMatch(/^home_assistant_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('instructions cover token, SSRF allowlist, Cloud reachability, UTC, non-admin user and privacy', () => {
    const i = a.instructions;
    expect(i.length).toBeGreaterThanOrEqual(800);
    expect(i).toMatch(/Long-lived access tokens/);
    expect(i).toMatch(/SSRF_ALLOWED_HOSTS/);
    expect(i).toMatch(/Cloud can only reach .* public internet over HTTPS/);
    expect(i).toMatch(/UTC with a `Z` suffix/);
    expect(i).toMatch(/non-admin/);
    expect(i).toMatch(/Assign this connector only to MCP servers/);
    const names = new Set(a.tools.map((t) => t.name));
    for (const m of [...i.matchAll(/\bhome_assistant_[a-z_]+/g), ...a.tools.flatMap((t) => [...t.description.matchAll(/\bhome_assistant_[a-z_]+/g)])]) expect(names).toContain(m[0]);
    for (const name of names) expect(i).toContain(`\`${name}\``);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, s] of Object.entries(t.parameters.properties ?? {})) expect(`${t.name}.${p}:${typeof s.description}`).toBe(`${t.name}.${p}:string`);
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
  });

  it('history always sends filter_entity_id and the fixed minimal_response/no_attributes flags', async () => {
    expect(tool('home_assistant_get_history').parameters.required).toEqual(['start_time', 'filter_entity_id']);
    mockedAxios.mockResolvedValue({ data: [] });
    await call('home_assistant_get_history', { start_time: '2026-10-01T00:00:00Z', filter_entity_id: 'sensor.a,sensor.b' });
    expect(sent().url).toBe(`${API}/history/period/2026-10-01T00:00:00Z`);
    const q = query();
    expect(q).toContain('filter_entity_id=sensor.a,sensor.b');
    expect(q).toContain('minimal_response=');
    expect(q).toContain('no_attributes=');
    expect(q).not.toContain('end_time');
  });

  it('logbook requires start_time and never sends context_id', async () => {
    expect(tool('home_assistant_get_logbook').parameters.required).toEqual(['start_time']);
    expect(tool('home_assistant_get_logbook').endpointMapping.queryParams).not.toHaveProperty('context_id');
    mockedAxios.mockResolvedValue({ data: [] });
    await call('home_assistant_get_logbook', { start_time: '2026-10-01T00:00:00Z', entity: 'binary_sensor.garage_door', period: 7 });
    expect(sent().url).toBe(`${API}/logbook/2026-10-01T00:00:00Z`);
    expect(query()).toContain('entity=binary_sensor.garage_door');
    expect(query()).toContain('period=7');
  });

  it('calendar events require start and end', async () => {
    expect(tool('home_assistant_get_calendar_events').parameters.required).toEqual(['entity_id', 'start', 'end']);
    mockedAxios.mockResolvedValue({ data: [] });
    await call('home_assistant_get_calendar_events', { entity_id: 'calendar.family', start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' });
    expect(sent().url).toBe(`${API}/calendars/calendar.family`);
    expect(query()).toContain('start=2026-10-01T00:00:00Z');
    expect(query()).toContain('end=2026-10-08T00:00:00Z');
  });

  const table: Array<[string, Record<string, unknown>, string]> = [
    ['home_assistant_get_config', {}, '/config'],
    ['home_assistant_list_states', {}, '/states'],
    ['home_assistant_get_state', { entity_id: 'sensor.living_room_temperature' }, '/states/sensor.living_room_temperature'],
    ['home_assistant_get_history', { start_time: '2026-10-01T00:00:00Z', filter_entity_id: 'sensor.x' }, '/history/period/2026-10-01T00:00:00Z'],
    ['home_assistant_get_logbook', { start_time: '2026-10-01T00:00:00Z' }, '/logbook/2026-10-01T00:00:00Z'],
    ['home_assistant_list_calendars', {}, '/calendars'],
    ['home_assistant_get_calendar_events', { entity_id: 'calendar.family', start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' }, '/calendars/calendar.family'],
  ];
  it('lists every tool in the URL table', () => expect(table.map(([n]) => n).sort()).toEqual(a.tools.map((t) => t.name).sort()));
  it.each(table)('%s sends GET to the right URL with the Bearer token', async (name, params, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    const req = sent();
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}${path}`);
    expect(req.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('list_states shapes each entity to a compact row', () => {
    const tr = tool('home_assistant_list_states').responseMapping!.transform;
    expect(validateTransform(tr)).toBeNull();
    const raw = [{ entity_id: 'sensor.t', state: '21.5', attributes: { friendly_name: 'Temp', unit_of_measurement: '°C', icon: 'x' }, last_changed: '2026-10-01T00:00:00+00:00', context: { id: 'c' } }];
    expect(applyResponseTransform(raw, tool('home_assistant_list_states').responseMapping as any).value).toEqual([
      { entity_id: 'sensor.t', state: '21.5', name: 'Temp', unit: '°C', last_changed: '2026-10-01T00:00:00+00:00' },
    ]);
  });
});

const live = process.env.RUN_HOME_ASSISTANT_LIVE === '1' && process.env.HOME_ASSISTANT_URL && process.env.HOME_ASSISTANT_TOKEN ? describe : describe.skip;
live('home-assistant adapter: live', () => {
  const env = { HOME_ASSISTANT_URL: process.env.HOME_ASSISTANT_URL!, HOME_ASSISTANT_TOKEN: process.env.HOME_ASSISTANT_TOKEN! };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  it('GET /api/config answers with the version and time zone', async () => {
    const res = await call('home_assistant_get_config', {}, env);
    const body = res.data ?? res;
    expect(body.version).toBeTruthy();
    expect(body.time_zone).toBeTruthy();
  }, 30000);
  it('GET /api/states lists entities', async () => {
    const res = await call('home_assistant_list_states', {}, env);
    const rows = applyResponseTransform(res.data ?? res, tool('home_assistant_list_states').responseMapping as any).value as any[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].entity_id).toMatch(/\./);
  }, 30000);
});
