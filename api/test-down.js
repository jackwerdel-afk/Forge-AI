// Temporary test endpoint — always returns 500
// Used to test uptime monitoring down detection
// DELETE THIS FILE after testing is complete
module.exports = async (req, res) => {
  res.status(500).json({ error: 'Simulated outage for testing' });
};
