import axios from 'axios';
import * as adapter from './klarna.json';
import { describeAdapterEnvVars } from '../env-var-meta';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';

/**
 * Two layers for the Klarna adapter:
 *
 *   1. Static: always runs. Pins Basic auth, the six API hosts, every tool's
 *      method and path, and that the connector is read-only.
 *
 *   2. Live: skipped unless RUN_KLARNA_LIVE=1. With credentials it lists
 *      payouts (and optionally one order):
 *
 *        RUN_KLARNA_LIVE=1 KLARNA_API_URL=https://api.playground.klarna.com \
 *          KLARNA_USERNAME=... KLARNA_PASSWORD=... \
 *          npx jest src/adapters/intl/klarna.live.spec.ts
 *
 *      Optional KLARNA_ORDER_ID reads that order. Nothing is written.
 */

type Tool = {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
  };
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  unlisted?: boolean;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; options?: Array<{ value: string }>; secret?: boolean }>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Tool[];
};

const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({
    name: t.name,
    connectorType: 'REST',
    endpointMapping: t.endpointMapping,
    annotations: t.annotations,
  });

const HOSTS = [
  'https://api.klarna.com',
  'https://api-na.klarna.com',
  'https://api-oc.klarna.com',
  'https://api.playground.klarna.com',
  'https://api-na.playground.klarna.com',
  'https://api-oc.playground.klarna.com',
];

describe('klarna adapter — static spec conformance', () => {
  it('is listed as an intl payments connector with Basic auth and a URL variable', () => {
    expect(a.unlisted).toBeUndefined();
    expect(a.slug).toBe('klarna');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('payments');
    expect(a.connector.baseUrl).toBe('{{KLARNA_API_URL}}');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({
      username: '{{KLARNA_USERNAME}}',
      password: '{{KLARNA_PASSWORD}}',
    });
    expect(a.requiredEnvVars).toEqual(['KLARNA_API_URL', 'KLARNA_USERNAME', 'KLARNA_PASSWORD']);
  });

  it('accepts Klarna live and Playground hosts for EU, NA and OC only', () => {
    const env = new RegExp(a.envVarMeta.KLARNA_API_URL.pattern!);
    for (const host of HOSTS) expect(env.test(host)).toBe(true);
    expect(env.test('https://api.klarna.com/')).toBe(false);
    expect(env.test('https://api.klarna.com.evil.example')).toBe(false);
    expect(env.test('https://api.evil.com')).toBe(false);
    expect(a.envVarMeta.KLARNA_API_URL.options!.map((o) => o.value).sort()).toEqual([...HOSTS].sort());
    const described = describeAdapterEnvVars(a as never);
    expect(described.find((d) => d.name === 'KLARNA_API_URL')!.kind).toBe('address');
    expect(described.find((d) => d.name === 'KLARNA_PASSWORD')!.secret).toBe(true);
  });

  it('probes list_payouts with size 1 and health-checks the same path', () => {
    expect(a.probe).toEqual({ tool: 'klarna_list_payouts', params: { size: 1 } });
    expect(a.connector.healthcheckPath).toBe('/settlements/v1/payouts?size=1');
  });

  it('prefixes every tool with klarna_', () => {
    const mine = a.tools.map((t) => t.name);
    expect(new Set(mine).size).toBe(mine.length);
    for (const name of mine) expect(name).toMatch(/^klarna_[a-z_]+$/);
  });

  it('exposes exactly the three read-only Order Management and Settlements tools', () => {
    expect(a.tools.map((t) => t.name)).toEqual([
      'klarna_get_order',
      'klarna_list_payouts',
      'klarna_list_transactions',
    ]);
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(annotationsOf(t).readOnlyHint).toBe(true);
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it('maps get order, list payouts and list transactions to Klarna paths and query params', () => {
    expect(tool('klarna_get_order').endpointMapping.path).toBe('/ordermanagement/v1/orders/{order_id}');
    expect(tool('klarna_get_order').parameters.required).toEqual(['order_id']);

    expect(tool('klarna_list_payouts').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/settlements/v1/payouts',
      queryParams: {
        start_date: '$start_date',
        end_date: '$end_date',
        currency_code: '$currency_code',
        size: '$size',
        offset: '$offset',
      },
    });

    expect(tool('klarna_list_transactions').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/settlements/v1/transactions',
      queryParams: {
        payment_reference: '$payment_reference',
        order_id: '$order_id',
        size: '$size',
        offset: '$offset',
      },
    });
  });

  it('writes no em dashes and only mentions tools that exist', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [...JSON.stringify(adapter).matchAll(/\bklarna_[a-z_]+/g)].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
  });
});

const live =
  process.env.RUN_KLARNA_LIVE === '1' &&
  process.env.KLARNA_USERNAME &&
  process.env.KLARNA_PASSWORD
    ? describe
    : describe.skip;

live('klarna adapter — live (read-only)', () => {
  const host = process.env.KLARNA_API_URL || 'https://api.playground.klarna.com';
  const auth = {
    username: process.env.KLARNA_USERNAME as string,
    password: process.env.KLARNA_PASSWORD as string,
  };
  const headers = { Accept: 'application/json' };

  it('lists payouts with size=1', async () => {
    const res = await axios.get(`${host}/settlements/v1/payouts`, {
      auth,
      headers,
      params: { size: 1 },
      timeout: 20000,
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
  }, 30000);

  it('reads one order when KLARNA_ORDER_ID is set', async () => {
    const orderId = process.env.KLARNA_ORDER_ID;
    if (!orderId) return;
    const res = await axios.get(`${host}/ordermanagement/v1/orders/${encodeURIComponent(orderId)}`, {
      auth,
      headers,
      timeout: 20000,
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    expect(res.data.order_id).toBe(orderId);
  }, 30000);

  it('lists transactions when a payment_reference is available', async () => {
    const payouts = await axios.get(`${host}/settlements/v1/payouts`, {
      auth,
      headers,
      params: { size: 1 },
      timeout: 20000,
    });
    const ref = payouts.data?.payouts?.[0]?.payment_reference;
    if (!ref) return;
    const res = await axios.get(`${host}/settlements/v1/transactions`, {
      auth,
      headers,
      params: { payment_reference: ref, size: 5 },
      timeout: 20000,
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
  }, 30000);
});
