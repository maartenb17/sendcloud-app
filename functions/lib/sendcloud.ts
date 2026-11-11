const API_BASE = 'https://panel.sendcloud.sc/api/v3';

// parcel statuses that mean there is no usable label
export const NO_LABEL_STATUSES = [999, 1001, 1002]; // no label, being announced, announcement failed
export const CANCELED_STATUSES = [1999, 2000, 2001]; // cancellation requested, cancelled, submitting cancellation

export interface SendcloudSettings {
  public_key?: string;
  secret_key?: string;
  integration_id?: number;
  webhook_signature_key?: string;
  sync_on?: 'paid' | 'submitted';
  skip_test_orders?: boolean;
  hold_separate_order_schedule?: boolean;
  show_subscription_plan?: boolean;
  show_bundle_components?: boolean;
  shipping_option_code?: string;
  default_weight?: number;
  create_fulfillment?: boolean;
  enabled?: boolean;
}

export interface SendcloudParcel {
  id: number;
  order_number?: string;
  tracking_number?: string;
  tracking_url?: string;
  status?: { id: number; message: string };
  carrier?: { code: string };
  shipment?: { id: number; name: string };
}

export class SendcloudError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function getSendcloudSettings(swell: SwellAPI): Promise<SendcloudSettings> {
  const all = await swell.settings();
  return all?.sendcloud || {};
}

export function hasCredentials(settings: SendcloudSettings): boolean {
  return Boolean(settings.public_key?.trim() && settings.secret_key?.trim() && settings.integration_id);
}

async function sendcloudRequest(
  settings: SendcloudSettings,
  method: string,
  path: string,
  body?: object,
): Promise<any> {
  const auth = btoa(`${settings.public_key?.trim()}:${settings.secret_key?.trim()}`);

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }

  if (!res.ok) {
    const message =
      json?.errors?.map((e: any) => [e.source?.pointer, e.detail || e.title].filter(Boolean).join(' ')).join('; ') ||
      json?.error?.message ||
      json?.message ||
      text ||
      res.statusText;
    throw new SendcloudError(`Sendcloud ${res.status}: ${message}`, res.status);
  }

  return json;
}

// Sendcloud identifies an Incoming Order by order_id plus the integration id.
// Posting the same Swell order id again updates that order; it does not create a second one.
export async function upsertOrder(
  settings: SendcloudSettings,
  order: object,
): Promise<{ id: number; order_id: string; order_number: string }> {
  const result = await sendcloudRequest(settings, 'POST', '/orders', [order]);
  return result?.data?.[0];
}

// removes the order from Incoming Orders; existing shipments are not affected
export async function deleteOrder(settings: SendcloudSettings, sendcloudOrderId: number): Promise<void> {
  await sendcloudRequest(settings, 'DELETE', `/orders/${sendcloudOrderId}`);
}

// Sendcloud signs with the Secret Key, or a separate Webhook Signature Key for some integration types
export function getSignatureKey(settings: SendcloudSettings): string {
  return settings.webhook_signature_key?.trim() || settings.secret_key?.trim() || '';
}

// Python json.dumps() defaults: ", " / ": " separators and ensure_ascii (\uXXXX for non-ASCII).
// Sendcloud signs its payload serialized this way, and the platform does not pass the
// original bytes through (req.rawBody arrives re-serialized), so we rebuild them.
export function toPythonJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(toPythonJson).join(', ')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${toPythonJson(key)}: ${toPythonJson(item)}`)
      .join(', ')}}`;
  }
  if (typeof value === 'string') {
    return JSON.stringify(value).replace(
      /[\u0080-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  }
  return JSON.stringify(value);
}

// Sendcloud-Signature: hex HMAC-SHA256 of the raw body, keyed with the secret key
export async function verifySignature(
  rawBody: string,
  signature: string | null,
  secretKey: string,
): Promise<boolean> {
  if (!signature || !secretKey) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const actual = signature.trim().toLowerCase();
  if (actual.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// --- Swell order → Sendcloud order mapping ---

const KG_PER_UNIT: Record<string, number> = {
  g: 0.001,
  kg: 1,
  oz: 0.0283495,
  lb: 0.453592,
};

export async function getWeightUnit(swell: SwellAPI): Promise<string> {
  const shipments = await swell.get('/settings/shipments');
  return shipments?.weight_unit || 'lb';
}

function toKg(weight: number, unit: string): number {
  return weight * (KG_PER_UNIT[unit] ?? KG_PER_UNIT.lb);
}

function roundKg(kg: number): number {
  // Sendcloud rejects 0 weights
  return Math.max(Math.round(kg * 1000) / 1000, 0.001);
}

function price(value: number | undefined, currency: string) {
  return { value: Math.round((value || 0) * 100) / 100, currency };
}

// split "Stationsstraat 12A" / "417 Montgomery St" into street and house number
export function splitAddress(address1: string): { address_line_1: string; house_number?: string } {
  const value = address1.trim();

  // leading number first, so "417 Main St Apt 5" keeps "Apt 5" in the street
  const leading = value.match(/^(\d+[\w\-\/]*)[\s,]+(.*[^\d\s].*)$/);
  if (leading) {
    return { address_line_1: leading[2], house_number: leading[1] };
  }

  const trailing = value.match(/^(.*?[^\d\s].*?)[\s,]+(\d+[\w\-\/]*)$/);
  if (trailing) {
    return { address_line_1: trailing[1], house_number: trailing[2] };
  }

  return { address_line_1: value };
}

export function shippableItems(order: any): any[] {
  return (order.items || []).filter((item: any) => item.delivery === 'shipment');
}

function formatAddress(address: any, email?: string) {
  if (!address?.address1) {
    return undefined;
  }

  return {
    name: address.name || `${address.first_name || ''} ${address.last_name || ''}`.trim(),
    company_name: address.company || undefined,
    ...splitAddress(address.address1),
    address_line_2: address.address2 || undefined,
    postal_code: address.zip,
    city: address.city,
    state_province_code: address.state || undefined,
    country_code: address.country?.toUpperCase(),
    email: email || undefined,
    phone_number: address.phone || undefined,
  };
}

// soft hyphens and other invisible characters must not reach the packing slip
export function visibleText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\p{Cf}\p{Cc}]/gu, '').trim();
}

export function packingSlipName(item: any): string {
  const base = visibleText(item?.product?.name || item?.product_name) || 'Item';
  const plan = visibleText(item?.packing_slip_plan);
  return plan ? `${base} (${plan})` : base;
}

// one place to swap the arrow for " – " if the packing-slip pdf cannot draw it
export const BUNDLE_COMPONENT_SEPARATOR = ' → ';

function bundleComponents(item: any): any[] {
  if (!Array.isArray(item?.bundle_items)) {
    return [];
  }
  return item.bundle_items.filter((child: any) => child?.product_id);
}

function componentQuantity(child: any, parent: any): number {
  const total = Number(child?.quantity_total);
  if (Number.isFinite(total) && total > 0) {
    return total;
  }
  const each = Number(child?.quantity) || 0;
  const bundles = Number(parent?.quantity) || 1;
  return each * bundles;
}

function componentSlipName(parent: any, child: any): string {
  const bundle = visibleText(parent?.product?.name || parent?.product_name) || 'Item';
  const component = visibleText(child?.product?.name || child?.product_name) || 'Item';
  const base = `${bundle}${BUNDLE_COMPONENT_SEPARATOR}${component}`;
  const plan = visibleText(parent?.packing_slip_plan);
  return plan ? `${base} (${plan})` : base;
}

function componentUnitPrice(child: any): number {
  const value = Number(child?.price);
  return Number.isFinite(value) ? value : 0;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

// same basis as a normal line: price_total is the line total after discount
function bundleLineTotal(parent: any): number {
  const total = Number(parent?.price_total);
  return Number.isFinite(total) ? roundCents(total) : 0;
}

// one component takes the whole bundle total. several split by unit price × quantity,
// or by quantity when none of them has a price. the last line absorbs the rounding.
function componentShareTotals(lines: { unit: number; quantity: number }[], bundleTotal: number): number[] {
  if (!lines.length || bundleTotal === 0) return lines.map(() => 0);
  const priced = lines.map((line) => line.unit * line.quantity);
  const pricedSum = priced.reduce((sum, value) => sum + value, 0);
  const weights = pricedSum > 0 ? priced : lines.map((line) => line.quantity);
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  if (weightSum <= 0) return lines.map(() => 0);

  let allocated = 0;
  return lines.map((_, index) => {
    if (index === lines.length - 1) return roundCents(bundleTotal - allocated);
    const share = roundCents((bundleTotal * weights[index]) / weightSum);
    allocated = roundCents(allocated + share);
    return share;
  });
}

// line weight is the whole component row. an empty row uses the product weight per unit.
function componentUnitWeight(child: any, quantity: number): number {
  const line = Number(child?.shipment_weight);
  if (Number.isFinite(line) && line > 0 && quantity > 0) {
    return line / quantity;
  }
  const productWeight = Number(child?.product?.shipment_weight);
  return Number.isFinite(productWeight) && productWeight > 0 ? productWeight : 0;
}

function expandBundle(item: any): any[] {
  const children = bundleComponents(item);
  if (!children.length) {
    return [item];
  }
  const lines = [];
  for (const child of children) {
    const quantity = componentQuantity(child, item);
    if (quantity <= 0) {
      continue;
    }
    const unit = componentUnitPrice(child);
    lines.push({
      id: child.id || `${item.id}:${child.product_id}`,
      product_id: child.product_id,
      variant_id: child.variant_id || undefined,
      quantity,
      product: child.product,
      variant: child.variant,
      component_name: componentSlipName(item, child),
      component_sku: child.product?.sku || child.sku || undefined,
      component_unit_price: unit,
      component_unit_weight: componentUnitWeight(child, quantity),
    });
  }
  if (!lines.length) return [item];
  const shares = componentShareTotals(
    lines.map((line) => ({ unit: line.component_unit_price, quantity: line.quantity })),
    bundleLineTotal(item),
  );
  return lines.map((line, index) => ({ ...line, component_total_price: shares[index] }));
}

// POST /api/v3/orders payload for one Swell order
export function buildOrder(order: any, settings: SendcloudSettings, weightUnit: string): object {
  const currency = order.currency;
  const email = order.account?.email;
  const items = shippableItems(order);
  const slipItems =
    settings.show_bundle_components === true ? items.flatMap((item: any) => expandBundle(item)) : items;

  const orderItems = slipItems.map((item: any) => {
    const quantity = item.quantity || 1;
    const unitWeight =
      item.component_unit_weight != null
        ? item.component_unit_weight
        : (item.shipment_weight || 0) / quantity;

    return {
      item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id || undefined,
      name: (item.component_name || packingSlipName(item)).slice(0, 255),
      description: item.variant?.name || item.variant_name || undefined,
      quantity,
      sku: item.component_sku || item.variant?.sku || item.product?.sku || undefined,
      hs_code: item.product?.hs_code || undefined,
      country_of_origin: item.product?.origin_country || undefined,
      image_url: item.product?.images?.[0]?.file?.url || undefined,
      unit_price: price(item.component_unit_price != null ? item.component_unit_price : item.price, currency),
      total_price: price(
        item.component_total_price != null ? item.component_total_price : item.price_total,
        currency,
      ),
      ...(unitWeight > 0 && {
        measurement: { weight: { value: roundKg(toKg(unitWeight, weightUnit)), unit: 'kg' } },
      }),
    };
  });

  const totalWeight = items.reduce((sum: number, item: any) => sum + (item.shipment_weight || 0), 0);
  const weightKg = totalWeight > 0 ? toKg(totalWeight, weightUnit) : settings.default_weight || 1;

  const shippingAddress = formatAddress(order.shipping, email);

  return {
    order_id: String(order.id),
    order_number: String(order.number),
    order_details: {
      integration: { id: Number(settings.integration_id) },
      status: { code: order.status, message: order.status },
      order_created_at: order.date_created,
      order_updated_at: order.date_updated || undefined,
      order_items: orderItems,
      notes: order.comments || undefined,
    },
    payment_details: {
      total_price: price(order.grand_total, currency),
      subtotal_price: price(order.sub_total, currency),
      estimated_shipping_price: price(order.shipment_total, currency),
      estimated_tax_price: price(order.tax_total, currency),
      status: order.paid ? { code: 'paid', message: 'Paid' } : { code: 'unpaid', message: 'Unpaid' },
    },
    customer_details: {
      name: shippingAddress?.name || order.account?.name || email || 'Customer',
      email: email || undefined,
      phone_number: order.account?.phone || order.shipping?.phone || undefined,
    },
    billing_address: formatAddress(order.billing, email),
    shipping_address: shippingAddress,
    shipping_details: {
      is_local_pickup: Boolean(order.shipping?.pickup),
      delivery_indicator: order.shipping?.service_name || undefined,
      measurement: { weight: { value: roundKg(weightKg), unit: 'kg' } },
      ...(settings.shipping_option_code?.trim() && {
        ship_with: {
          type: 'shipping_option_code',
          properties: { shipping_option_code: settings.shipping_option_code.trim() },
        },
      }),
    },
  };
}

// app values on a standard record are keyed by app slug in responses
export function getAppData(record: any, appId: string): Record<string, any> {
  return record?.$app?.[appId] || record?.$app?.sendcloud || {};
}

// --- when to send -----------------------------------------------------------

export const WAITING_FOR_INVOICE = 'Waiting for invoice payment';
export const WAITING_FOR_OVERDUE = 'Waiting for overdue payments';

const ARREARS_INVOICE_STATUSES = new Set(['pending', 'unpaid']);
// invoice and order can be this far apart and still belong together (step 0d)
export const INVOICE_WINDOW_MS = 26 * 60 * 60 * 1000;
export const ORDER_EXPAND = ['account', 'items.product', 'items.variant'];

export function isTestOrder(order: any): boolean {
  return order?.test === true || order?.metadata?.test === true;
}

// live orders set both; either one is enough
export function isCanceledOrder(order: any): boolean {
  return order?.status === 'canceled' || order?.canceled === true;
}

export function isSubscriptionCanceled(subscription: any): boolean {
  return subscription?.status === 'canceled' || subscription?.canceled === true;
}

// Swell's past-due status is "pastdue". "unpaid" is the closed-arrears status.
export function subscriptionInArrears(subscription: any): boolean {
  return subscription?.status === 'pastdue' || subscription?.status === 'unpaid';
}

// an earlier pending or unpaid invoice blocks the shipment. void does not.
export function earlierInvoiceInArrears(ownInvoice: any, invoices: any[]): boolean {
  const ownTime = time(ownInvoice?.date_created);
  if (!Number.isFinite(ownTime)) {
    return false;
  }
  return (invoices || []).some((invoice) => {
    if (!invoice?.id || invoice.id === ownInvoice.id) {
      return false;
    }
    if (invoice.void === true || invoice.status === 'void') {
      return false;
    }
    if (!ARREARS_INVOICE_STATUSES.has(invoice.status)) {
      return false;
    }
    const created = time(invoice.date_created);
    return Number.isFinite(created) && created < ownTime;
  });
}

// true when the subscription ships on a different cadence than it bills.
// an empty order_schedule means orders follow the billing schedule.
export function hasSeparateOrderSchedule(subscription: any): boolean {
  const order = subscription?.order_schedule;
  const billing = subscription?.billing_schedule;
  if (!order?.interval) {
    return false;
  }
  return (
    order.interval !== billing?.interval ||
    (order.interval_count ?? 1) !== (billing?.interval_count ?? 1)
  );
}

function localeCode(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const code = value.split(',')[0]?.trim();
  return code || undefined;
}

// account.locale, then the order's display locale, then the account's.
// one code: "en,nl" is the same as "en". No code means the store language.
export function customerLocale(order: any): string | undefined {
  const candidates = [order?.account?.locale, order?.display_locale, order?.account?.display_locale];
  for (const value of candidates) {
    const code = localeCode(value);
    if (code) {
      return code;
    }
  }
  return undefined;
}

// a dashboard order often has no locale of its own. the account's locale is the contact preference.
export async function withCustomerLocale(swell: SwellAPI, order: any): Promise<any> {
  if (customerLocale(order)) {
    return order;
  }
  const accountId =
    (typeof order?.account === 'string' && order.account) || order?.account?.id || order?.account_id;
  if (!accountId) {
    return order;
  }
  try {
    const account = await swell.get(`/accounts/${accountId}`);
    if (!customerLocale({ account })) {
      return order;
    }
    return {
      ...order,
      account: {
        ...(order?.account && typeof order.account === 'object' ? order.account : {}),
        ...account,
      },
    };
  } catch (err: any) {
    console.error(
      `Sendcloud: could not load account ${accountId} for the packing slip language - ${err?.message || err}`,
    );
    return order;
  }
}

export async function withLocalizedNames(swell: SwellAPI, order: any): Promise<any> {
  const locale = customerLocale(order);
  if (!locale) {
    return order;
  }

  const products = new Map<string, any>();
  const items = [];
  for (const item of order.items || []) {
    if (!item?.product_id) {
      items.push(item);
      continue;
    }
    if (!products.has(item.product_id)) {
      try {
        products.set(
          item.product_id,
          await swell.get(`/products/${item.product_id}`, { $locale: locale, expand: ['variants'] }),
        );
      } catch (err: any) {
        console.error(`Sendcloud: could not load product ${item.product_id} in ${locale} - ${err?.message || err}`);
        products.set(item.product_id, null);
      }
    }
    const product = products.get(item.product_id);
    const variants = product?.variants?.results || product?.variants || [];
    const variant = variants.find((entry: any) => entry?.id === item.variant_id);
    items.push({
      ...item,
      product: {
        ...item.product,
        ...(product || {}),
        name: product?.name || item.product?.name,
      },
      ...(item.variant_id && {
        variant: {
          ...item.variant,
          ...(variant || {}),
          name: variant?.name || item.variant?.name,
        },
      }),
    });
  }
  return { ...order, items };
}

export async function withBundleComponentProducts(swell: SwellAPI, order: any): Promise<any> {
  const locale = customerLocale(order);
  const cache = new Map<string, any>();

  async function load(productId: string): Promise<any> {
    if (cache.has(productId)) {
      return cache.get(productId);
    }
    try {
      const product = await swell.get(`/products/${productId}`, locale ? { $locale: locale } : undefined);
      cache.set(productId, product);
      return product;
    } catch (err: any) {
      console.error(
        `Sendcloud: could not load bundle component ${productId}${locale ? ` in ${locale}` : ''} - ${err?.message || err}`,
      );
      cache.set(productId, null);
      return null;
    }
  }

  const items = [];
  for (const item of order.items || []) {
    if (!bundleComponents(item).length) {
      items.push(item);
      continue;
    }
    const children = [];
    for (const child of item.bundle_items) {
      if (!child?.product_id) {
        children.push(child);
        continue;
      }
      const product = await load(child.product_id);
      children.push({
        ...child,
        product: {
          ...child.product,
          ...(product || {}),
          name: product?.name || child.product?.name,
          sku: product?.sku || child.product?.sku,
          shipment_weight: product?.shipment_weight ?? child.product?.shipment_weight,
        },
      });
    }
    items.push({ ...item, bundle_items: children });
  }
  return { ...order, items };
}

function subscriptionPlanId(item: any): string {
  const id =
    item?.purchase_option?.plan_id ||
    item?.purchase_option?.subscription?.plan_id ||
    item?.product_option?.plan?.id;
  return typeof id === 'string' ? id : '';
}

// a renewal is often type "standard" with a nested plan id. a one-off has neither.
function isSubscriptionLine(item: any, parent?: any): boolean {
  if (subscriptionPlanId(item) || subscriptionPlanId(parent)) {
    return true;
  }
  if (item?.purchase_option?.type === 'subscription' || parent?.purchase_option?.type === 'subscription') {
    return true;
  }
  return Boolean(item?.subscription_id || parent?.subscription_id);
}

// the product was loaded in the customer's language. its plan beats the text stored on the order.
function localizedPlanText(item: any, parent: any, planId: string): string {
  if (!planId) {
    return '';
  }
  for (const entry of [item, parent]) {
    const plans = entry?.product?.purchase_options?.subscription?.plans;
    if (!Array.isArray(plans)) {
      continue;
    }
    const match = plans.find((plan: any) => plan?.id === planId);
    const text = visibleText(match?.description) || visibleText(match?.name);
    if (text) {
      return text;
    }
  }
  return '';
}

// description on the line, then on the bundle parent. plan_name is English, so it is last.
export function orderLinePlanText(item: any, parent?: any): string {
  for (const entry of [item, parent]) {
    const description =
      visibleText(entry?.product_option?.plan?.description) || visibleText(entry?.purchase_option?.plan_description);
    if (description) {
      return description;
    }
  }
  for (const entry of [item, parent]) {
    const name = visibleText(entry?.purchase_option?.plan_name);
    if (name) {
      return name;
    }
  }
  return '';
}

function bundleParent(order: any, item: any): any | undefined {
  if (!item?.id) {
    return undefined;
  }
  return (order?.items || []).find(
    (entry: any) => entry !== item && entry?.bundle_items?.some((child: any) => child?.id === item.id),
  );
}

// plan text for the packing slip. with a customer language, the plan record wins.
// otherwise, or when that record has no text, the order line does. no text means no suffix.
export async function withSubscriptionPlans(swell: SwellAPI, order: any): Promise<any> {
  const locale = customerLocale(order);
  const cache = new Map<string, string>();

  async function planFromApi(planId: string): Promise<string> {
    if (!locale || !planId) {
      return '';
    }
    const key = `${locale}:${planId}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let text = '';
    try {
      const plan = await swell.get(`/subscription-plans/${planId}`, { $locale: locale });
      text = visibleText(plan?.description) || visibleText(plan?.name);
    } catch (err: any) {
      console.error(
        `Sendcloud: could not load subscription plan ${planId} in ${locale} - ${err?.message || err}`,
      );
    }
    cache.set(key, text);
    return text;
  }

  const items = [];
  for (const item of order.items || []) {
    const parent = bundleParent(order, item);
    let plan = '';
    if (isSubscriptionLine(item, parent)) {
      const planId = subscriptionPlanId(item) || subscriptionPlanId(parent);
      plan =
        (await planFromApi(planId)) ||
        (locale ? localizedPlanText(item, parent, planId) : '') ||
        orderLinePlanText(item, parent);
    }
    items.push(plan ? { ...item, packing_slip_plan: plan } : item);
  }
  return { ...order, items };
}

function time(value: unknown): number {
  const parsed = new Date(value as string).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

// the order in the list closest to this invoice, but only inside the 26-hour window.
// an exact tie goes to the earlier order, so one invoice is never claimed twice.
export function orderClosestToInvoice(invoice: any, orders: any[]): any | null {
  const at = time(invoice?.date_created);
  if (!Number.isFinite(at)) {
    return null;
  }
  let best: any = null;
  let bestDistance = Infinity;
  for (const order of orders) {
    const distance = Math.abs(time(order?.date_created) - at);
    if (!Number.isFinite(distance) || distance > INVOICE_WINDOW_MS) {
      continue;
    }
    const earlier = best && String(order.date_created) < String(best.date_created);
    if (distance < bestDistance || (distance === bestDistance && earlier)) {
      best = order;
      bestDistance = distance;
    }
  }
  return best;
}

// the invoice this order may claim: nearest one inside 26 hours for which this
// order is the closest order. Invoices outside the window, or closer to another
// order, are not returned.
export function chooseInvoice(order: any, invoices: any[], orders: any[]): any | null {
  const at = time(order?.date_created);
  if (!Number.isFinite(at)) {
    return null;
  }
  let best: any = null;
  let bestDistance = Infinity;
  for (const invoice of invoices) {
    if (!invoice?.id) {
      continue;
    }
    const distance = Math.abs(time(invoice.date_created) - at);
    if (!Number.isFinite(distance) || distance > INVOICE_WINDOW_MS) {
      continue;
    }
    if (orderClosestToInvoice(invoice, orders)?.id !== order.id) {
      continue;
    }
    if (distance < bestDistance) {
      best = invoice;
      bestDistance = distance;
    }
  }
  return best;
}

async function listAround(
  swell: SwellAPI,
  path: '/orders' | '/invoices',
  subscriptionId: string,
  center: number,
  windowMs: number,
): Promise<any[]> {
  const found = await swell.get(path, {
    where: {
      subscription_id: subscriptionId,
      date_created: {
        $gte: new Date(center - windowMs).toISOString(),
        $lte: new Date(center + windowMs).toISOString(),
      },
    },
    limit: 50,
    ...(path === '/orders' && { expand: ORDER_EXPAND }),
  });
  return found?.results || [];
}

export interface InvoiceDecision {
  applies: boolean;
  invoice: { id: string; status?: string } | null;
  block?: 'canceled' | 'overdue' | null;
}

// applies to every order of a subscription that ships on its own schedule,
// except the order that created the subscription. A website checkout often has
// no subscription_id; a dashboard subscription's first order does, and still waits.
// the returned invoice is unset when none can be claimed, including when another
// order already holds that invoice id.
export async function renewalInvoice(swell: SwellAPI, appId: string, order: any): Promise<InvoiceDecision> {
  if (!order?.subscription_id || !order?.date_created) {
    return { applies: false, invoice: null };
  }
  const subscription = await swell.get(`/subscriptions/${order.subscription_id}`);
  if (!hasSeparateOrderSchedule(subscription)) {
    return { applies: false, invoice: null };
  }
  if (subscription?.order_id && subscription.order_id === order.id) {
    return { applies: false, invoice: null };
  }
  if (isSubscriptionCanceled(subscription)) {
    return { applies: true, invoice: null, block: 'canceled' };
  }

  const center = time(order.date_created);
  const [invoices, siblings] = await Promise.all([
    listAround(swell, '/invoices', order.subscription_id, center, INVOICE_WINDOW_MS),
    listAround(swell, '/orders', order.subscription_id, center, INVOICE_WINDOW_MS * 2),
  ]);
  const orders = [order, ...siblings.filter((entry) => entry.id !== order.id && entry.id !== subscription.order_id)];
  const invoice = chooseInvoice(order, invoices, orders);
  if (!invoice) {
    return { applies: true, invoice: null };
  }
  const holders = await swell.get('/orders', {
    where: { [`$app.${appId}.sendcloud_invoice_id`]: invoice.id },
    limit: 5,
  });
  if ((holders?.results || []).some((entry: any) => entry.id !== order.id)) {
    return { applies: true, invoice: null };
  }
  if (invoice.status !== 'paid') {
    return { applies: true, invoice: { id: invoice.id, status: invoice.status } };
  }
  const openInvoices = await swell.get('/invoices', {
    where: {
      subscription_id: order.subscription_id,
      status: { $in: ['pending', 'unpaid'] },
    },
  });
  const overdue =
    subscriptionInArrears(subscription) || earlierInvoiceInArrears(invoice, openInvoices?.results || []);
  return {
    applies: true,
    invoice: { id: invoice.id, status: invoice.status },
    block: overdue ? 'overdue' : null,
  };
}

export async function pushOrder(
  swell: SwellAPI,
  settings: SendcloudSettings,
  order: any,
  values: (data: Record<string, any>) => any,
  extra: Record<string, any> = {},
): Promise<{ id?: number }> {
  const weightUnit = await getWeightUnit(swell);
  const withLocale = await withCustomerLocale(swell, order);
  const localized = await withLocalizedNames(swell, withLocale);
  const named =
    settings.show_subscription_plan === true ? await withSubscriptionPlans(swell, localized) : localized;
  const prepared =
    settings.show_bundle_components === true ? await withBundleComponentProducts(swell, named) : named;
  const created = await upsertOrder(settings, buildOrder(prepared, settings, weightUnit));
  await swell.put(
    `/orders/${order.id}`,
    values({
      sendcloud_order_id: created?.id,
      sendcloud_status: 'Sent to Sendcloud',
      sendcloud_error: null,
      ...extra,
    }),
  );
  return created;
}
