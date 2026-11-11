import {
  ORDER_EXPAND,
  SendcloudError,
  WAITING_FOR_INVOICE,
  getAppData,
  getSendcloudSettings,
  hasCredentials,
  isTestOrder,
  pushOrder,
  shippableItems,
} from './lib/sendcloud';

export const config = {
  description: 'Send selected orders to Sendcloud',
  action: true,
  timeout: 10000,
} as SwellConfig;

// one run can send this many orders; the dashboard action refuses a larger selection
export const MAX_SELECTION = 10;
// stop before the 10 second function limit, and say which orders were not reached
export const BUDGET_MS = 8_000;
export const TIME_LIMIT_REASON = 'the time limit for one run was reached; run it again to send the rest';

const RECORD_ID = /^[0-9a-f]{24}$/i;
const MANUAL_NOTE = 'Sent to Sendcloud manually while waiting for invoice payment.';

export default function (req: SwellRequest) {
  return runAction('Send to Sendcloud', () => send(req));
}

async function send(req: SwellRequest) {
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
    fail('Select the orders to send.');
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
  const updated: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let stoppedBecause: string | undefined;
  for (const order of orders) {
    if (Date.now() - started > BUDGET_MS) {
      stoppedBecause = TIME_LIMIT_REASON;
      break;
    }
    const result = await sendOne(req, settings, order);
    if (result.status === 'sent') {
      sent.push(result.reason ? `${order.number} (${result.reason})` : String(order.number));
      continue;
    }
    if (result.status === 'updated') {
      updated.push(result.reason ? `${order.number} (${result.reason})` : String(order.number));
      continue;
    }
    if (result.status === 'skipped') {
      skipped.push(`${order.number}: ${result.reason}`);
      continue;
    }
    failed.push(`${order.number}: ${result.reason}`);
    if (result.stop) {
      break;
    }
  }

  const message = summary(sent, updated, skipped, failed, orders.length, stoppedBecause);
  if ((!sent.length && !updated.length) || failed.length) {
    fail(message);
  }
  return { message };
}

interface Outcome {
  status: 'sent' | 'updated' | 'skipped' | 'failed';
  reason?: string;
  stop?: boolean;
}

async function sendOne(req: SwellRequest, settings: Awaited<ReturnType<typeof getSendcloudSettings>>, order: any): Promise<Outcome> {
  const appData = getAppData(order, req.appId || 'sendcloud');
  if (!shippableItems(order).length) {
    return { status: 'failed', reason: 'no shippable items' };
  }
  if (!order.shipping?.address1 || !order.shipping?.country) {
    return { status: 'failed', reason: 'missing shipping address' };
  }
  if (appData.sendcloud_parcel_id) {
    return { status: 'skipped', reason: `Order ${order.number} already has a label in Sendcloud` };
  }

  const notes: string[] = [];
  if (appData.sendcloud_status === WAITING_FOR_INVOICE) {
    console.log(`Sendcloud: order ${order.number} sent manually while waiting for invoice payment`);
    notes.push('sent manually while waiting for invoice payment');
    try {
      await req.swell.post('/notes', {
        body: MANUAL_NOTE,
        collection: 'orders',
        record_id: order.id,
      });
    } catch (err: any) {
      console.error(`Sendcloud: could not note the manual send on order ${order.number} - ${err?.message || err}`);
    }
  }
  if (isTestOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is a test order, sending manually`);
    notes.push('test order, sent manually');
  }

  const updating = Boolean(appData.sendcloud_order_id);
  try {
    const created = await pushOrder(
      req.swell,
      settings,
      order,
      (values) => req.appValues(values),
      appData.sendcloud_invoice_id ? { sendcloud_invoice_id: appData.sendcloud_invoice_id } : {},
    );
    console.log(
      updating
        ? `Sendcloud: updated order ${order.number} in Sendcloud (${created?.id})`
        : `Sendcloud: sent order ${order.number} as Sendcloud order ${created?.id}`,
    );
    return { status: updating ? 'updated' : 'sent', reason: notes.join('; ') || undefined };
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Sendcloud: failed to send order ${order.number} - ${message}`);
    await req.swell.put(`/orders/${order.id}`, req.appValues({ sendcloud_error: message }));
    return {
      status: 'failed',
      reason: message,
      stop: err instanceof SendcloudError && err.status >= 500,
    };
  }
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
  updated: string[],
  skipped: string[],
  failed: string[],
  total: number,
  stoppedBecause?: string,
): string {
  const parts = [
    sent.length
      ? `Sent ${sent.length} order${sent.length === 1 ? '' : 's'} to Sendcloud: ${list(sent)}.`
      : '',
    updated.length
      ? `Updated ${updated.length} order${updated.length === 1 ? '' : 's'} in Sendcloud: ${list(updated)}.`
      : '',
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
  const stopped = total - sent.length - updated.length - failed.length - skipped.length;
  if (stopped > 0) {
    parts.push(`Stopped before ${stopped} more${stoppedBecause ? `: ${stoppedBecause}` : ''}.`);
  }
  return parts.join(' ');
}
