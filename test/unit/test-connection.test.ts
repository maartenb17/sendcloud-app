import { afterEach, describe, expect, it, vi } from "vitest";
import testConnection from "../../functions/test-connection";
import { createMockRequest } from "../helpers/mock-request";

const SETTINGS = { public_key: "pub", secret_key: "secret", integration_id: 626842 };

function request(settings: Record<string, unknown>, respond: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => respond(String(url))));
  return createMockRequest({
    swell: { settings: vi.fn(async () => ({ sendcloud: settings })) },
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("test-connection action", () => {
  it("names the account and integration it reached", async () => {
    const req = request(SETTINGS, (url) =>
      url.endsWith("/user")
        ? json(200, { user: { username: "acme", company_name: "Acme BV" } })
        : json(200, { id: 626842, shop_name: "Swell store" }),
    );

    await expect(testConnection(req)).resolves.toEqual({
      message: "Connected to Sendcloud account Acme BV, integration Swell store.",
    });
    expect((fetch as any).mock.calls.map(([url]: [string]) => url)).toEqual([
      "https://panel.sendcloud.sc/api/v2/user",
      "https://panel.sendcloud.sc/api/v2/integrations/626842",
    ]);
  });

  it("works while the app is turned off and says so", async () => {
    const req = request({ ...SETTINGS, enabled: false }, (url) =>
      url.endsWith("/user") ? json(200, { user: { username: "acme" } }) : json(200, { shop_name: "Swell store" }),
    );

    await expect(testConnection(req)).resolves.toEqual({
      message:
        "Connected to Sendcloud account acme, integration Swell store. The app is turned off in its settings, so nothing is sent or synced.",
    });
  });

  it("says the keys were rejected on a 401", async () => {
    // what Sendcloud sends for wrong keys
    const req = request(SETTINGS, () =>
      json(401, { error: { code: 401, status: "Unauthorized", message: "The request could not be authorized" } }),
    );

    await expect(testConnection(req)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/didn't accept the Public Key and Secret Key/) });
  });

  it("fails when the integration does not belong to the keys", async () => {
    const req = request(SETTINGS, (url) =>
      url.endsWith("/user")
        ? json(200, { user: { username: "acme" } })
        : json(404, { error: { code: 404, message: "Not found" } }),
    );

    await expect(testConnection(req)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/integration 626842 doesn't belong to these keys/) });
  });

  it("asks for the missing settings before calling Sendcloud", async () => {
    const req = request({ public_key: "pub" }, () => json(200, {}));

    await expect(testConnection(req)).rejects.toMatchObject({
      status: 400,
      message: "Add the Secret Key and Integration ID and save the settings first.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails with a red popup when Sendcloud can't be reached", async () => {
    const req = request(SETTINGS, () => {
      throw new TypeError("fetch failed");
    });

    await expect(testConnection(req)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/^Couldn't reach Sendcloud/),
    });
  });
});
