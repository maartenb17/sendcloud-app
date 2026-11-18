import {
  SendcloudError,
  SendcloudSettings,
  NOT_SENT_SUBSCRIPTION_CANCELED,
  WAITING_FOR_INVOICE,
  WAITING_FOR_OVERDUE,
  canceledParcel,
  getAppData,
  isCanceledOrder,
  isTestOrder,
  paymentAllowsSend,
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

// same decision as the automatic send: skip a test or canceled order, and when
// the setting is "Order is paid" skip an unpaid order without changing it.
// hold a separate order schedule until its invoice is paid and nothing is overdue.
export async function syncOrder(
  swell: SwellAPI,
  settings: SendcloudSettings,
  order: any,
  appId: string,
  appValues: (data: Record<string, any>) => any,
  options?: { resendCanceledParcel?: boolean },
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
  // a canceled parcel is sent as a new Incoming Order; an order already in Sendcloud, or an active label, is not
  const resendCanceled = options?.resendCanceledParcel === true && canceledParcel(appData);
  if (appData.sendcloud_order_id && !resendCanceled) {
    console.log(`Sendcloud: order ${order.number} already sent as Sendcloud order ${appData.sendcloud_order_id}`);
    return { status: 'skipped', reason: 'already in Sendcloud' };
  }
  if (!paymentAllowsSend(settings, order)) {
    console.log(`Sendcloud: order ${order.number} is not paid, skipping`);
    return { status: 'skipped', reason: 'not paid' };
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
      if (appData.sendcloud_status !== NOT_SENT_SUBSCRIPTION_CANCELED) {
        await swell.put(
          `/orders/${order.id}`,
          appValues({
            sendcloud_status: NOT_SENT_SUBSCRIPTION_CANCELED,
            sendcloud_error: null,
          }),
        );
      }
      console.log(`Sendcloud: order ${order.number} not sent, subscription is canceled`);
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
      { appId, newOrderAfterCanceledParcel: options?.resendCanceledParcel === true },
    );
    console.log(
      created.replaced
        ? `Sendcloud: order ${order.number} sent as Sendcloud order ${created.id}; previous order ${created.previousId} left in Sendcloud with a canceled parcel`
        : `Sendcloud: sent order ${order.number} as Sendcloud order ${created?.id}`,
    );
    return { status: 'sent' };
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Sendcloud: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${order.id}`, appValues({ sendcloud_error: message }));
    const retry = !(err instanceof SendcloudError && err.status < 500);
    return { status: 'failed', reason: message, retry, error: err };
  }
}
