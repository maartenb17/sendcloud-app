import {
  INVOICE_WINDOW_MS,
  NOT_SENT_SUBSCRIPTION_CANCELED,
  ORDER_CHANGED_AFTER_LABEL,
  ORDER_EXPAND,
  REMOVED_FROM_SENDCLOUD,
  REMOVED_SHIPPED_OUTSIDE,
  SendcloudError,
  WAITING_FOR_INVOICE,
  WAITING_FOR_OVERDUE,
  buildOrder,
  deleteOrder,
  earlierInvoiceInArrears,
  externalOrderId,
  getAppData,
  getSendcloudSettings,
  getWeightUnit,
  hasActiveLabel,
  hasCredentials,
  hasSeparateOrderSchedule,
  isCanceledOrder,
  isSubscriptionCanceled,
  isTestOrder,
  orderClosestToInvoice,
  paymentAllowsSend,
  pushOrder,
  shippableItems,
  subscriptionInArrears,
  upsertOrder,
  withBundleComponentProducts,
  withCustomerLocale,
  withLocalizedNames,
  withSubscriptionPlans,
} from './lib/sendcloud';
import { deliverableItems, orderWithRemainingQuantities, sendcloudSyncHash } from './lib/shipments';
import { syncOrder } from './lib/sync-order';

export const config: SwellConfig = {
  description: 'Send orders to Sendcloud, keep them in sync, and remove them when canceled or nothing is left to ship',
  model: {
    events: [
      'order.submitted',
      'order.paid',
      'order.updated',
      'order.canceled',
      'shipment.created',
      'invoice.created',
      'invoice.payment_succeeded',
      'subscription.invoiced',
      'subscription.updated',
    ],
  },
};

const OWN_SHIPMENT_NOTE = /^Sendcloud parcel /;

export default async function (req: SwellRequest) {
  const eventType = req.data.$event?.type;
  if (eventType === 'shipment.created' || eventType === 'order.updated') {
    return syncSendcloudOrder(req);
  }
  if (eventType === 'subscription.updated') {
    return handleSubscription(req);
  }
  if (
    eventType === 'invoice.created' ||
    eventType === 'invoice.payment_succeeded' ||
    eventType === 'subscription.invoiced'
  ) {
    return handleInvoice(req);
  }
  return handleOrder(req);
}

async function handleOrder(req: SwellRequest) {
  const { swell, data, appId } = req;
  const eventType = data.$event?.type;
  const orderId: string = data.id;
  const settings = await getSendcloudSettings(swell);

  if (settings.enabled === false) {
    return;
  }
  if (!hasCredentials(settings)) {
    console.error('Sendcloud: missing required settings (public_key, secret_key, integration_id)');
    return;
  }

  const order = await swell.get(`/orders/${orderId}`, { expand: ORDER_EXPAND });
  if (!order) {
    console.error(`Sendcloud: order ${orderId} not found`);
    return;
  }

  if (eventType === 'order.canceled') {
    const appData = getAppData(order, appId || 'sendcloud');
    if (!appData.sendcloud_order_id) return;
    try {
      await deleteOrder(settings, appData.sendcloud_order_id);
      console.log(`Sendcloud: removed order ${order.number} from Sendcloud incoming orders`);
    } catch (err: any) {
      // 404/410: order already gone
      if (!(err instanceof SendcloudError && [404, 410].includes(err.status))) {
        const message = `Couldn't remove the canceled order from Sendcloud: ${err?.message || String(err)}`;
        console.error(`Sendcloud: ${message}`);
        await swell.put(`/orders/${orderId}`, req.appValues({ sendcloud_error: message }));
        // only Sendcloud 5xx and network errors are worth a retry
        if (err instanceof SendcloudError && err.status < 500) return;
        throw err;
      }
    }
    // a parcel's status stays until its next webhook
    await swell.put(
      `/orders/${orderId}`,
      req.appValues({
        ...(!appData.sendcloud_parcel_id && { sendcloud_status: REMOVED_FROM_SENDCLOUD }),
        sendcloud_error: null,
      }),
    );
    return;
  }

  const syncEvent = settings.sync_on === 'submitted' ? 'order.submitted' : 'order.paid';
  if (eventType !== syncEvent) {
    return;
  }

  const outcome = await syncOrder(swell, settings, order, appId || 'sendcloud', (data) => req.appValues(data));
  if (outcome.status === 'failed' && outcome.retry) {
    throw outcome.error;
  }
}

async function handleInvoice(req: SwellRequest) {
  const { swell, data, appId } = req;
  const settings = await getSendcloudSettings(swell);
  if (settings.hold_separate_order_schedule !== true || settings.enabled === false) {
    return;
  }
  if (!hasCredentials(settings)) {
    console.error('Sendcloud: missing required settings (public_key, secret_key, integration_id)');
    return;
  }

  const invoice = await loadInvoice(swell, data);
  if (!invoice?.id || !invoice.subscription_id) {
    return;
  }
  if (invoice.status === 'paid') {
    const subscription = await swell.get(`/subscriptions/${invoice.subscription_id}`);
    if (hasSeparateOrderSchedule(subscription)) {
      await releaseHeldOrders(req, settings, subscription, invoice.subscription_id);
      return;
    }
  }

  const resolvedAppId = appId || 'sendcloud';
  const holders = await swell.get('/orders', {
    where: { [`$app.${resolvedAppId}.sendcloud_invoice_id`]: invoice.id },
    sort: 'date_created asc',
    limit: 5,
    expand: ORDER_EXPAND,
  });
  const linked = holders?.results || [];
  if (linked.length > 1) {
    console.log(`Sendcloud: invoice ${invoice.id} is linked to more than one order; using the earliest`);
  }
  const order = linked[0] || (await orderToLink(swell, invoice));
  if (!order) {
    return;
  }
  const appData = getAppData(order, resolvedAppId);
  if (appData.sendcloud_order_id) {
    return;
  }
  if (settings.skip_test_orders === true && isTestOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is a test order, skipping`);
    return;
  }
  if (isCanceledOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is canceled, skipping`);
    return;
  }
  if (invoice.status !== 'paid') {
    await swell.put(
      `/orders/${order.id}`,
      req.appValues({
        sendcloud_status: WAITING_FOR_INVOICE,
        sendcloud_invoice_id: invoice.id,
        sendcloud_error: null,
      }),
    );
    console.log(`Sendcloud: order ${order.number} is waiting for invoice payment`);
    return;
  }
  if (!paymentAllowsSend(settings, order)) {
    console.log(`Sendcloud: order ${order.number} is not paid, skipping`);
    return;
  }
  if (!shippableItems(order).length || !order.shipping?.address1 || !order.shipping?.country) {
    return;
  }

  try {
    const created = await pushOrder(swell, settings, order, (values) => req.appValues(values), {
      sendcloud_invoice_id: invoice.id,
    });
    console.log(`Sendcloud: sent order ${order.number} as Sendcloud order ${created?.id}`);
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Sendcloud: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${order.id}`, req.appValues({ sendcloud_error: message }));
    if (err instanceof SendcloudError && err.status < 500) {
      return;
    }
    throw err;
  }
}

async function handleSubscription(req: SwellRequest) {
  const { swell, data } = req;
  const settings = await getSendcloudSettings(swell);
  if (settings.hold_separate_order_schedule !== true || settings.enabled === false) {
    return;
  }
  if (!hasCredentials(settings)) {
    console.error('Sendcloud: missing required settings (public_key, secret_key, integration_id)');
    return;
  }
  if (!data?.id) {
    return;
  }
  const subscription = await swell.get(`/subscriptions/${data.id}`);
  await releaseHeldOrders(req, settings, subscription, data.id);
}

async function releaseHeldOrders(req: SwellRequest, settings: Awaited<ReturnType<typeof getSendcloudSettings>>, subscription: any, subscriptionId: string) {
  if (!hasSeparateOrderSchedule(subscription)) {
    return;
  }
  const { swell } = req;
  const [invoiceList, orderList] = await Promise.all([
    swell.get('/invoices', {
      where: { subscription_id: subscriptionId },
      sort: 'date_created asc',
      limit: 100,
    }),
    swell.get('/orders', {
      where: { subscription_id: subscriptionId },
      limit: 100,
      expand: ORDER_EXPAND,
    }),
  ]);
  const invoices = invoiceList?.results || [];
  for (const order of orderList?.results || []) {
    const appData = getAppData(order, req.appId || 'sendcloud');
    if (appData.sendcloud_order_id) {
      continue;
    }
    if (appData.sendcloud_status !== WAITING_FOR_INVOICE && appData.sendcloud_status !== WAITING_FOR_OVERDUE) {
      continue;
    }
    await settleHeldOrder(req, settings, subscription, invoices, order);
  }
}

async function settleHeldOrder(req: SwellRequest, settings: Awaited<ReturnType<typeof getSendcloudSettings>>, subscription: any, invoices: any[], order: any) {
  const { swell } = req;
  const appData = getAppData(order, req.appId || 'sendcloud');
  if (subscription?.order_id && subscription.order_id === order.id) {
    return;
  }
  if (settings.skip_test_orders === true && isTestOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is a test order, skipping`);
    return;
  }
  if (isCanceledOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is canceled, skipping`);
    return;
  }
  if (isSubscriptionCanceled(subscription)) {
    if (appData.sendcloud_status !== NOT_SENT_SUBSCRIPTION_CANCELED) {
      await swell.put(
        `/orders/${order.id}`,
        req.appValues({
          sendcloud_status: NOT_SENT_SUBSCRIPTION_CANCELED,
          sendcloud_error: null,
        }),
      );
    }
    console.log(`Sendcloud: order ${order.number} not sent, subscription is canceled`);
    return;
  }
  if (!paymentAllowsSend(settings, order)) {
    console.log(`Sendcloud: order ${order.number} is not paid, skipping`);
    return;
  }

  const own = invoices.find((invoice) => invoice.id === appData.sendcloud_invoice_id);
  if (!own || own.status !== 'paid') {
    return;
  }
  if (subscriptionInArrears(subscription) || earlierInvoiceInArrears(own, invoices)) {
    if (appData.sendcloud_status !== WAITING_FOR_OVERDUE) {
      await swell.put(
        `/orders/${order.id}`,
        req.appValues({
          sendcloud_status: WAITING_FOR_OVERDUE,
          sendcloud_invoice_id: own.id,
          sendcloud_error: null,
        }),
      );
    }
    console.log(`Sendcloud: order ${order.number} is waiting for overdue payments`);
    return;
  }
  if (!shippableItems(order).length || !order.shipping?.address1 || !order.shipping?.country) {
    return;
  }

  try {
    const created = await pushOrder(swell, settings, order, (values) => req.appValues(values), {
      sendcloud_invoice_id: own.id,
    });
    console.log(`Sendcloud: sent order ${order.number} as Sendcloud order ${created?.id}`);
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Sendcloud: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${order.id}`, req.appValues({ sendcloud_error: message }));
    if (err instanceof SendcloudError && err.status < 500) {
      return;
    }
    throw err;
  }
}

const APP_WRITE_IGNORED = new Set(['id', 'date_created', 'date_updated']);

// an order.updated that only stores this app's own fields, or was written by this app
function isOwnOrderWrite(data: any, appId: string): boolean {
  const event = data?.$event;
  if (event?.type !== 'order.updated') return false;
  const changed = event?.data;
  const keys =
    changed && typeof changed === 'object' && !Array.isArray(changed)
      ? Object.keys(changed).filter((key) => !APP_WRITE_IGNORED.has(key))
      : null;
  if (keys !== null && keys.length > 0 && keys.every((key) => key === '$app')) return true;
  return Boolean(event.app_id && String(event.app_id) === appId && (keys === null || keys.length === 0));
}

async function syncSendcloudOrder(req: SwellRequest) {
  const { swell, data, appId } = req;
  const settings = await getSendcloudSettings(swell);
  if (settings.sync_with_swell !== true || settings.enabled === false) {
    return;
  }
  if (!hasCredentials(settings)) {
    console.error('Sendcloud: missing required settings (public_key, secret_key, integration_id)');
    return;
  }
  const fromShipment = data.$event?.type === 'shipment.created';
  const notes = typeof data.notes === 'string' ? data.notes : '';
  if (fromShipment && OWN_SHIPMENT_NOTE.test(notes)) {
    return;
  }
  if (isOwnOrderWrite(data, appId || 'sendcloud')) {
    return;
  }
  const orderId = fromShipment ? data.order_id : data.id;
  if (!orderId) {
    return;
  }
  const order = await swell.get(`/orders/${orderId}`, { expand: ORDER_EXPAND });
  if (!order) {
    return;
  }
  const appData = getAppData(order, appId || 'sendcloud');
  if (fromShipment && data.id && appData.sendcloud_shipment_id && String(appData.sendcloud_shipment_id) === String(data.id)) {
    return;
  }
  if (!appData.sendcloud_order_id || isCanceledOrder(order)) {
    return;
  }
  if (appData.sendcloud_status === WAITING_FOR_INVOICE || appData.sendcloud_status === WAITING_FOR_OVERDUE) {
    return;
  }

  const hash = await sendcloudSyncHash(order);
  if (hasActiveLabel(appData)) {
    if (hash === appData.sendcloud_sync_hash || appData.sendcloud_note === ORDER_CHANGED_AFTER_LABEL) {
      return;
    }
    await swell.put(`/orders/${order.id}`, req.appValues({ sendcloud_note: ORDER_CHANGED_AFTER_LABEL }));
    return;
  }
  if (!deliverableItems(order).length) {
    await removeSyncedOrder(req, settings, order, appData, fromShipment);
    return;
  }
  if (hash === appData.sendcloud_sync_hash) {
    return;
  }
  await updateSyncedOrder(req, settings, order, appData, hash);
}

async function removeSyncedOrder(
  req: SwellRequest,
  settings: any,
  order: any,
  appData: Record<string, any>,
  fromShipment: boolean,
) {
  const { swell } = req;
  try {
    await deleteOrder(settings, appData.sendcloud_order_id);
    console.log(
      fromShipment
        ? `Sendcloud: removed order ${order.number} from Sendcloud incoming orders; shipped outside Sendcloud`
        : `Sendcloud: removed order ${order.number} from Sendcloud incoming orders`,
    );
  } catch (err: any) {
    if (!(err instanceof SendcloudError && [404, 410].includes(err.status))) {
      const message = `Couldn't remove the order from Sendcloud: ${err?.message || String(err)}`;
      console.error(`Sendcloud: ${message}`);
      await swell.put(`/orders/${order.id}`, req.appValues({ sendcloud_error: message }));
      if (err instanceof SendcloudError && err.status < 500) return;
      throw err;
    }
  }
  const status =
    fromShipment || appData.sendcloud_status === REMOVED_SHIPPED_OUTSIDE
      ? REMOVED_SHIPPED_OUTSIDE
      : REMOVED_FROM_SENDCLOUD;
  await swell.put(
    `/orders/${order.id}`,
    req.appValues({
      sendcloud_status: status,
      sendcloud_error: null,
    }),
  );
}

// same Incoming Order: remaining lines and the current address, bundles counted per component
async function updateSyncedOrder(req: SwellRequest, settings: any, order: any, appData: Record<string, any>, hash: string) {
  const { swell } = req;
  try {
    const weightUnit = await getWeightUnit(swell);
    const withLocale = await withCustomerLocale(swell, order);
    const localized = await withLocalizedNames(swell, withLocale);
    const named = settings.show_subscription_plan === true ? await withSubscriptionPlans(swell, localized) : localized;
    const prepared = settings.show_bundle_components === true ? await withBundleComponentProducts(swell, named) : named;
    const suffix = Number(appData.sendcloud_order_suffix) || 1;
    await upsertOrder(
      settings,
      buildOrder(orderWithRemainingQuantities(prepared), settings, weightUnit, externalOrderId(order.id, suffix)),
    );
    console.log(`Sendcloud: updated order ${order.number} to match the Swell order`);
  } catch (err: any) {
    const message = `Couldn't update the Sendcloud order: ${err?.message || String(err)}`;
    console.error(`Sendcloud: ${message}`);
    await swell.put(`/orders/${order.id}`, req.appValues({ sendcloud_error: message }));
    if (err instanceof SendcloudError && err.status < 500) return;
    throw err;
  }
  await swell.put(
    `/orders/${order.id}`,
    req.appValues({
      sendcloud_sync_hash: hash,
      sendcloud_error: null,
    }),
  );
}

async function loadInvoice(swell: SwellAPI, data: any): Promise<any | null> {
  if (data.$event?.type === 'subscription.invoiced') {
    const found = await swell.get('/invoices', {
      where: { subscription_id: data.id },
      sort: 'date_created desc',
      limit: 1,
    });
    return found?.results?.[0] || null;
  }
  return (await swell.get(`/invoices/${data.id}`)) || null;
}

async function orderToLink(swell: SwellAPI, invoice: any): Promise<any | null> {
  const subscription = await swell.get(`/subscriptions/${invoice.subscription_id}`);
  if (!hasSeparateOrderSchedule(subscription)) {
    return null;
  }
  const center = new Date(invoice.date_created).getTime();
  if (!Number.isFinite(center)) {
    return null;
  }
  const around = await swell.get('/orders', {
    where: {
      subscription_id: invoice.subscription_id,
      date_created: {
        $gte: new Date(center - INVOICE_WINDOW_MS).toISOString(),
        $lte: new Date(center + INVOICE_WINDOW_MS).toISOString(),
      },
    },
    limit: 50,
    expand: ORDER_EXPAND,
  });
  const candidates = (around?.results || []).filter((entry: any) => entry.id !== subscription.order_id);
  return orderClosestToInvoice(invoice, candidates);
}
