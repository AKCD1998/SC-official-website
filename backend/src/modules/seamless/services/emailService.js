const sgMail = require("@sendgrid/mail");
const { readEmailConfig } = require("../config");
const { badRequest } = require("../errors");
const { parseEmailList } = require("../validators");

let configuredApiKey = "";

function ensureConfigured() {
  const emailConfig = readEmailConfig();

  if (!["brevo", "sendgrid"].includes(emailConfig.provider)) {
    throw badRequest(`Unsupported EMAIL_PROVIDER: ${emailConfig.provider}`);
  }

  if (emailConfig.provider === "brevo" && !emailConfig.brevoApiKey) {
    throw badRequest("Email delivery is not configured (missing BREVO_API_KEY).");
  }

  if (emailConfig.provider === "sendgrid" && !emailConfig.sendgridApiKey) {
    throw badRequest("Email delivery is not configured (missing SENDGRID_API_KEY).");
  }

  if (!emailConfig.mailFrom) {
    throw badRequest("Email delivery is not configured (missing MAIL_USER).");
  }

  if (emailConfig.provider === "sendgrid" && configuredApiKey !== emailConfig.sendgridApiKey) {
    sgMail.setApiKey(emailConfig.sendgridApiKey);
    configuredApiKey = emailConfig.sendgridApiKey;
  }

  return emailConfig;
}

async function sendWithBrevo({ emailConfig, recipients, subject, text, filename, buffer }) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": emailConfig.brevoApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: emailConfig.mailFrom, name: "ClaspSCxSeamless" },
      to: recipients.map((email) => ({ email })),
      subject,
      textContent: text,
      attachment: [{ content: buffer.toString("base64"), name: filename }],
    }),
  });

  if (!response.ok) {
    let details = "";
    try {
      const payload = await response.json();
      details = payload.message || payload.code || "";
    } catch {
      details = await response.text().catch(() => "");
    }
    throw new Error(`Brevo email delivery failed (${response.status})${details ? `: ${details}` : ""}`);
  }
}

async function sendGeneratedFileEmail({ to, subject, text, filename, mimeType, buffer }) {
  const emailConfig = ensureConfigured();
  const recipients = parseEmailList(to);

  if (!recipients.length) {
    throw badRequest("A valid recipient email address is required.");
  }

  if (emailConfig.provider === "brevo") {
    await sendWithBrevo({ emailConfig, recipients, subject, text, filename, buffer });
    return;
  }

  const msg = {
    to: recipients,
    from: {
      email: emailConfig.mailFrom,
      name: "ClaspSCxSeamless",
    },
    subject,
    text,
    attachments: [
      {
        content: buffer.toString("base64"),
        filename,
        type: mimeType || "application/octet-stream",
        disposition: "attachment",
      },
    ],
  };

  await sgMail.send(msg);
}

module.exports = { sendGeneratedFileEmail };
