export default async function handler(req, res) {
  return res.status(501).json({
    error: "Not implemented",
    message: "Cancellation requires secure customer verification. Not built yet.",
  });
}
