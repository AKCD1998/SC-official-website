const { sendTextAlert } = require("../src/modules/seamless/services/lineNotifyService");

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.SEAMLESS_LINE_TARGET_ID;
});

describe("lineNotifyService.sendTextAlert", () => {
  test("skips (does not call fetch) when LINE is not configured", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;

    const result = await sendTextAlert("test alert");

    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("pushes a plain text message to the configured LINE target", async () => {
    process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN = "test-token";
    process.env.SEAMLESS_LINE_TARGET_ID = "test-target";
    const fetchSpy = jest.fn(async () => ({ ok: true }));
    global.fetch = fetchSpy;

    const result = await sendTextAlert("⚠️ PharmCare Gmail sync failed: boom");

    expect(result.skipped).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/message/push");
    expect(options.headers.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(options.body);
    expect(body.to).toBe("test-target");
    expect(body.messages).toEqual([{ type: "text", text: "⚠️ PharmCare Gmail sync failed: boom" }]);
  });

  test("throws when the LINE API responds with a non-ok status", async () => {
    process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN = "test-token";
    process.env.SEAMLESS_LINE_TARGET_ID = "test-target";
    global.fetch = jest.fn(async () => ({ ok: false, status: 400, text: async () => "bad request" }));

    await expect(sendTextAlert("test")).rejects.toThrow(/LINE push failed with status 400/);
  });

  test("truncates text longer than LINE's 5000-char message limit", async () => {
    process.env.SEAMLESS_LINE_CHANNEL_ACCESS_TOKEN = "test-token";
    process.env.SEAMLESS_LINE_TARGET_ID = "test-target";
    const fetchSpy = jest.fn(async () => ({ ok: true }));
    global.fetch = fetchSpy;

    await sendTextAlert("x".repeat(6000));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.messages[0].text.length).toBeLessThanOrEqual(4900);
  });
});
