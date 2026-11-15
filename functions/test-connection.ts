import { API_V2_BASE, SendcloudError, getSendcloudSettings, hasCredentials, sendcloudRequest } from './lib/sendcloud';

export const config: SwellConfig = {
  description: 'Check the Sendcloud keys and integration ID',
  action: true,
};

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

function reachError(err: unknown): string {
  return `Couldn't reach Sendcloud (${err instanceof Error ? err.message : String(err)}). Try again in a minute.`;
}

// read-only: reads the account and the integration, creates nothing
export default async function (req: SwellRequest) {
  const settings = await getSendcloudSettings(req.swell);

  if (!hasCredentials(settings)) {
    const missing = [
      !settings.public_key?.trim() && 'Public Key',
      !settings.secret_key?.trim() && 'Secret Key',
      !settings.integration_id && 'Integration ID',
    ].filter(Boolean);
    const names = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0];
    fail(`Add the ${names} and save the settings first.`);
  }

  let user: Record<string, any>;
  try {
    user = (await sendcloudRequest(settings, 'GET', '/user', undefined, API_V2_BASE))?.user ?? {};
  } catch (err) {
    if (err instanceof SendcloudError && err.status === 401) {
      fail("Sendcloud didn't accept the Public Key and Secret Key. Copy both again from your Sendcloud API integration.");
    }
    fail(err instanceof SendcloudError ? err.message : reachError(err));
  }
  const account = String(user.company_name || user.username || 'your account');

  let integration: Record<string, any>;
  try {
    const res = await sendcloudRequest(settings, 'GET', `/integrations/${settings.integration_id}`, undefined, API_V2_BASE);
    integration = res?.integration ?? res ?? {};
  } catch (err) {
    if (err instanceof SendcloudError && (err.status === 403 || err.status === 404)) {
      fail(
        `Connected to Sendcloud account ${account}, but integration ${settings.integration_id} doesn't belong to these keys. Check the Integration ID in the integration's URL in Sendcloud.`,
      );
    }
    fail(err instanceof SendcloudError ? err.message : reachError(err));
  }

  const off = settings.enabled === false ? ' The app is turned off in its settings, so nothing is sent or synced.' : '';
  return {
    message: `Connected to Sendcloud account ${account}, integration ${String(integration.shop_name || settings.integration_id)}.${off}`,
  };
}
