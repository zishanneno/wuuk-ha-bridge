export interface WuukAccount {
  user_id: string;
  token: string;
  enable_two_factor_login?: boolean;
}

export interface WuukDevice {
  sn?: string;
  name?: string;
  model?: string;
  kind?: number | string;
  did?: string;
  init_string?: string;
  paired_devices?: WuukDevice[];
}

export class WuukClient {
  constructor(private readonly deviceId: string) {}

  async login(email: string, password: string): Promise<WuukAccount> {
    const user = await this.request<WuukAccount>('user/login', { email, password });
    if (user?.enable_two_factor_login) throw new Error('Wuuk requires two-factor verification');
    if (!user?.user_id || !user.token) throw new Error('Wuuk login did not return a session');
    return user;
  }

  listDevices(user: WuukAccount): Promise<WuukDevice[]> {
    return this.request(`v2/user/${encodeURIComponent(user.user_id)}/device/all`, undefined, user.token);
  }

  async registerPush(user: WuukAccount, token: string): Promise<void> {
    await this.request(`user/${encodeURIComponent(user.user_id)}/push_token/update`,
      { token, language: 'en', platform: 'android' }, user.token);
  }

  private async request<T>(path: string, fields?: Record<string, string>, bearer?: string): Promise<T> {
    const headers: Record<string, string> = {
      'X-App-Version': 'android-4.2.5',
      'X-App-Model': 'Android',
      'X-Device-ID': this.deviceId,
      'X-OS-Version': 'Android 14',
      'X-Locale': 'en',
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const response = await fetch(`https://api.wuuklabs.io/${path}`, {
      method: fields ? 'POST' : 'GET',
      headers,
      body: fields ? new URLSearchParams(fields) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => null) as { data: T; error?: { code?: number } } | null;
    if (!response.ok || !result || result.error) {
      const operation = path === 'user/login' ? 'login' : fields ? 'push registration' : 'device discovery';
      const code = result?.error?.code;
      throw new Error(`Wuuk ${operation} failed (HTTP ${response.status}${typeof code === 'number' ? `, API code ${code}` : ''})`);
    }
    return result.data;
  }
}

export interface WuukEvent {
  serial: string;
  name?: string;
  type: 'ring' | 'camera_activity';
  kind: 1 | 5;
  time?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

export function decodePush(message: unknown): WuukEvent | undefined {
  const envelope = record(message);
  const data = record(envelope?.data) ?? record(record(envelope?.message)?.data);
  const kind = Number(data?.kind);
  if ((kind !== 1 && kind !== 5) || typeof data?.sn !== 'string' || !data.sn.trim()) return;
  return {
    serial: data.sn,
    name: typeof data.name === 'string' ? data.name : undefined,
    type: kind === 1 ? 'ring' : 'camera_activity',
    kind,
    time: typeof data.time === 'number' || typeof data.time === 'string' ? String(data.time) : undefined,
  };
}
