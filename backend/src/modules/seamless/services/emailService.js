const sgMail = require("@sendgrid/mail");
const { readEmailConfig } = require("../config");
const { badRequest } = require("../errors");

let configuredApiKey = "";

function ensureConfigured() {
  const emailConfig = readEmailConfig();

  if (!emailConfig.sendgridApiKey) {
    throw badRequest("Email delivery is not configured (missing SENDGRID_API_KEY).");
  }

  if (!emailConfig.mailFrom) {
    throw badRequest("Email delivery is not configured (missing MAIL_USER).");
  }

  if (configuredApiKey !== emailConfig.sendgridApiKey) {
    sgMail.setApiKey(emailConfig.sendgridApiKey);
    configuredApiKey = emailConfig.sendgridApiKey;
  }

  return emailConfig;
}

async function sendGeneratedFileEmail({ to, subject, text, filename, mimeType, buffer }) {
  const emailConfig = ensureConfigured();

  const msg = {
    to,
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
