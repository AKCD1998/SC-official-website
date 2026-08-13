describe("seamless Brevo email delivery", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.resetModules();
  });

  test("sends an xlsx attachment through Brevo", async () => {
    process.env = {
      ...originalEnv,
      EMAIL_PROVIDER: "brevo",
      BREVO_API_KEY: "test-brevo-key",
      MAIL_USER: "admin@example.test",
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201 });
    const { sendGeneratedFileEmail } = require("../src/modules/seamless/services/emailService");

    await sendGeneratedFileEmail({
      to: "accounting@example.test",
      subject: "Workbook",
      text: "Attached",
      filename: "report.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("xlsx-bytes"),
    });

    const [url, options] = global.fetch.mock.calls[0];
    const payload = JSON.parse(options.body);
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(options.headers["api-key"]).toBe("test-brevo-key");
    expect(payload.sender).toEqual({ email: "admin@example.test", name: "ClaspSCxSeamless" });
    expect(payload.to).toEqual([{ email: "accounting@example.test" }]);
    expect(payload.attachment).toEqual([{ content: Buffer.from("xlsx-bytes").toString("base64"), name: "report.xlsx" }]);
  });
});
