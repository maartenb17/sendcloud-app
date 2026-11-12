import {
  SendcloudError,
  SendcloudSettings,
  WAITING_FOR_INVOICE,
  WAITING_FOR_OVERDUE,
  getAppData,
  isCanceledOrder,
  isTestOrder,
  pushOrder,
  renewalInvoice,
  shippableItems,
} from './sendcloud';

export interface SyncOutcome {
  status: 'sent' | 'skipped' | 'waiting' | 'failed';
  reason?: string;
  retry?: boolean;
  error?: unknown;
}

// same decision as order.paid: skip a test or canceled order, hold a separate
// order schedule until its invoice is paid and nothing is overdue, otherwise send.
export async function syncOrder(
  swell: SwellAPI,
  settings: SendcloudSettings,
  order: any,
  appId: string,
  appValues: (data: Record<string, any>) => any,
): Promise<SyncOutcome> {
  const appData = getAppData(order, appId);
  if (isCanceledOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is canceled, skipping`);
    return { status: 'skipped', reason: 'order is canceled' };
  }
  if (settings.skip_test_orders === true && isTestOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is a test order, skipping`);
    return { status: 'skipped', reason: 'order is a test order' };
  }
  if (appData.sendcloud_order_id) {
    console.log(`Sendcloud: order ${order.number} already sent as Sendcloud order ${appData.sendcloud_order_id}`);
    return { status: 'skipped', reason: 'already in Sendcloud' };
  }
  if (!shippableItems(order).length) {
    console.log(`Sendcloud: order ${order.number} has no shippable items, skipping`);
    return { status: 'skipped', reason: 'no shippable items' };
  }
  if (!order.shipping?.address1 || !order.shipping?.country) {
    await swell.put(`/orders/${order.id}`, appValues({ sendcloud_error: 'Missing shipping address' }));
    return { status: 'failed', reason: 'missing shipping address' };
  }

  let invoiceId: string | undefined;
  if (settings.hold_separate_order_schedule === true) {
    const decision = await renewalInvoice(swell, appId, order);
    if (decision.block === 'canceled') {
      console.log(`Sendcloud: order ${order.number} subscription is canceled, skipping`);
      return { status: 'skipped', reason: 'subscription is canceled' };
    }
    if (decision.applies && decision.invoice?.status !== 'paid') {
      await swell.put(
        `/orders/${order.id}`,
        appValues({
          sendcloud_status: WAITING_FOR_INVOICE,
          ...(decision.invoice?.id && { sendcloud_invoice_id: decision.invoice.id }),
          sendcloud_error: null,
        }),
      );
      console.log(`Sendcloud: order ${order.number} is waiting for invoice payment`);
      return { status: 'waiting', reason: 'waiting for invoice payment' };
    }
    if (decision.block === 'overdue') {
      await swell.put(
        `/orders/${order.id}`,
        appValues({
          sendcloud_status: WAITING_FOR_OVERDUE,
          ...(decision.invoice?.id && { sendcloud_invoice_id: decision.invoice.id }),
          sendcloud_error: null,
        }),
      );
      console.log(`Sendcloud: order ${order.number} is waiting for overdue payments`);
      return { status: 'waiting', reason: 'waiting for overdue payments' };
    }
    invoiceId = decision.invoice?.id;
  }

  try {
    const created = await pushOrder(
      swell,
      settings,
      order,
      appValues,
      invoiceId ? { sendcloud_invoice_id: invoiceId } : {},
    );
    console.log(`Sendcloud: sent order ${order.number} as Sendcloud order ${created?.id}`);
    return { status: 'sent' };
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Sendcloud: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${order.id}`, appValues({ sendcloud_error: message }));
    const retry = !(err instanceof SendcloudError && err.status < 500);
    return { status: 'failed', reason: message, retry, error: err };
  }
}
