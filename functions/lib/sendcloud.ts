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

// create or update (upsert by order_id + integration id) one order in Incoming Orders
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

// POST /api/v3/orders payload for one Swell order
export function buildOrder(order: any, settings: SendcloudSettings, weightUnit: string): object {
  const currency = order.currency;
  const email = order.account?.email;
  const items = shippableItems(order);

  const orderItems = items.map((item: any) => {
    const quantity = item.quantity || 1;
    const unitWeight = (item.shipment_weight || 0) / quantity;

    return {
      item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id || undefined,
      name: (item.product?.name || item.product_name || 'Item').slice(0, 255),
      description: item.variant?.name || item.variant_name || undefined,
      quantity,
      sku: item.variant?.sku || item.product?.sku || undefined,
      hs_code: item.product?.hs_code || undefined,
      country_of_origin: item.product?.origin_country || undefined,
      image_url: item.product?.images?.[0]?.file?.url || undefined,
      unit_price: price(item.price, currency),
      total_price: price(item.price_total, currency),
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

export function isTestOrder(order: any): boolean {
  return order?.test === true || order?.metadata?.test === true;
}
