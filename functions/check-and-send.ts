import {
  ORDER_EXPAND,
  getSendcloudSettings,
  hasCredentials,
} from './lib/sendcloud';
import { syncOrder } from './lib/sync-order';

export const config = {
  description: 'Check the normal send rules, then send or hold the order',
  action: true,
  timeout: 10000,
} as SwellConfig;

export const MAX_SELECTION = 10;
export const BUDGET_MS = 8_000;
export const TIME_LIMIT_REASON = 'the time limit for one run was reached; run it again for the rest';

const RECORD_ID = /^[0-9a-f]{24}$/i;

export default function (req: SwellRequest) {
  return runAction('Check and send to Sendcloud', () => checkAndSend(req));
}

async function checkAndSend(req: SwellRequest) {
  const started = Date.now();
  const action = req.data.$action;
  if (action?.collection !== 'orders') {
    fail('Run this action from orders.');
  }

  let query: Record<string, any>;
  if (action.source === 'record') {
    if (!RECORD_ID.test(String(action.record_id || ''))) {
      fail('Open an order to run this action.');
    }
    query = { where: { id: action.record_id } };
  } else if (action.source === 'bulk' && action.selection?.query) {
    query = action.selection.query;
  } else {
    fail('Select the orders to check.');
  }

  const settings = await getSendcloudSettings(req.swell);
  if (settings.enabled === false) {
    fail('The Sendcloud app is turned off in its settings.');
  }
  if (!hasCredentials(settings)) {
    fail('Add the Public Key, Secret Key and Integration ID in Apps → Sendcloud first.');
  }

  const found = await req.swell.get('/orders', { ...query, limit: MAX_SELECTION + 1, expand: ORDER_EXPAND });
  const orders: any[] = found?.results ?? [];
  if (!orders.length) {
    fail('No orders found.');
  }
  if (orders.length > MAX_SELECTION) {
    fail(`Select up to ${MAX_SELECTION} orders.`);
  }

  const sent: string[] = [];
  const waiting: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let stoppedBecause: string | undefined;
  for (const order of orders) {
    if (Date.now() - started > BUDGET_MS) {
      stoppedBecause = TIME_LIMIT_REASON;
      break;
    }
    const result = await syncOrder(
      req.swell,
      settings,
      order,
      req.appId || 'sendcloud',
      (values) => req.appValues(values),
    );
    if (result.status === 'sent') {
      sent.push(String(order.number));
      continue;
    }
    if (result.status === 'waiting') {
      waiting.push(`${order.number}: ${result.reason}`);
      continue;
    }
    if (result.status === 'skipped') {
      skipped.push(`${order.number}: ${result.reason}`);
      continue;
    }
    failed.push(`${order.number}: ${result.reason}`);
    if (result.retry) {
      stoppedBecause = result.reason;
      break;
    }
  }

  const message = summary(sent, waiting, skipped, failed, orders.length, stoppedBecause);
  if ((!sent.length && !waiting.length) || failed.length) {
    fail(message);
  }
  return { message };
}

function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

async function runAction<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SwellError) {
      throw err;
    }
    console.error(`Sendcloud: ${name} failed - ${err instanceof Error ? err.stack || err.message : err}`);
    fail(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const list = (items: string[]) =>
  `${items.slice(0, 5).join(' · ')}${items.length > 5 ? ` and ${items.length - 5} more` : ''}`;

export function summary(
  sent: string[],
  waiting: string[],
  skipped: string[],
  failed: string[],
  total: number,
  stoppedBecause?: string,
): string {
  const parts = [
    sent.length ? `Sent ${sent.length} order${sent.length === 1 ? '' : 's'} to Sendcloud: ${list(sent)}.` : '',
    waiting.length ? `Waiting: ${list(waiting)}.` : '',
  ].filter(Boolean);
  if (!parts.length) {
    parts.push('Nothing sent to Sendcloud.');
  }
  if (failed.length) {
    parts.push(`Failed: ${list(failed)}.`);
  }
  if (skipped.length) {
    parts.push(`Skipped: ${list(skipped)}.`);
  }
  const stopped = total - sent.length - waiting.length - failed.length - skipped.length;
  if (stopped > 0) {
    parts.push(`Stopped before ${stopped} more${stoppedBecause ? `: ${stoppedBecause}` : ''}.`);
  }
  return parts.join(' ');
}
