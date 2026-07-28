const Sentry = require("@sentry/node");
Sentry.init({ dsn: "https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616", environment: "production" });

module.exports = async (req, res) => {
  // Intentional error to verify Sentry is working
  Sentry.captureException(new Error("Sentry Node.js test from Forge AI API"));
  await Sentry.flush(2000);
  return res.status(200).json({ success: true, message: "Sentry test triggered" });
};
