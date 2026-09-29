// Apprise client: URL construction for apprise-api v2.0.0 stateful (multi) mode.
import { describe, expect, it } from 'vitest';
import { AppriseClient } from '../src/server/integrations/apprise/client.js';

describe('apprise client endpoint', () => {
  it('sends the tag as a query string filter (body tag is ignored by v2.0.0)', () => {
    const client = new AppriseClient({
      apiUrl: 'https://apprise.example.com',
      configKey: 'toolkit',
      tag: 'feishu',
    });
    expect(client.endpoint).toBe('https://apprise.example.com/notify/toolkit?tags=feishu');
  });

  it('encodes special characters in key and tag', () => {
    const client = new AppriseClient({
      apiUrl: 'http://a.local',
      configKey: 'my key',
      tag: '渠道A',
    });
    const url = new URL(client.endpoint);
    expect(url.pathname).toBe('/notify/my%20key');
    expect(url.searchParams.get('tags')).toBe('渠道A');
  });

  it('omits the query string when no tag is configured', () => {
    const client = new AppriseClient({ apiUrl: 'http://a.local', configKey: 'k' });
    expect(client.endpoint).toBe('http://a.local/notify/k');
  });
});

function stubFetch(capture: { headers?: Headers }): typeof fetch {
  const fn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    capture.headers = new Headers(init?.headers);
    return new Response(null, { status: 200 });
  };
  return fn as typeof fetch;
}

describe('apprise client basic auth', () => {
  it('attaches an Authorization header when credentials are configured', async () => {
    const capture: { headers?: Headers } = {};
    const client = new AppriseClient({
      apiUrl: 'http://a.local',
      configKey: 'k',
      tag: 'feishu',
      user: 'toolkit',
      password: 's3cret',
      fetchImpl: stubFetch(capture),
    });
    const result = await client.notify({ title: 't', body: 'b', type: 'info' });
    expect(result).toEqual({ ok: true });
    expect(capture.headers?.get('Authorization')).toBe(
      `Basic ${Buffer.from('toolkit:s3cret').toString('base64')}`,
    );
  });

  it('sends no Authorization header in anonymous (公开) mode', async () => {
    const capture: { headers?: Headers } = {};
    const client = new AppriseClient({
      apiUrl: 'http://a.local',
      configKey: 'k',
      fetchImpl: stubFetch(capture),
    });
    await client.notify({ title: 't', body: 'b', type: 'info' });
    expect(capture.headers?.get('Authorization')).toBeNull();
  });

  it('supports password-only credentials (empty username)', async () => {
    const capture: { headers?: Headers } = {};
    const client = new AppriseClient({
      apiUrl: 'http://a.local',
      configKey: 'k',
      password: 'onlypass',
      fetchImpl: stubFetch(capture),
    });
    await client.notify({ title: 't', body: 'b', type: 'info' });
    expect(capture.headers?.get('Authorization')).toBe(
      `Basic ${Buffer.from(':onlypass').toString('base64')}`,
    );
  });
});
