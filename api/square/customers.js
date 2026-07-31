export default async function handler(req, res) {
  return res.status(501).json({
    error: "Not implemented",
    message:
      "Customer lookup and creation happen internally when creating a booking. This endpoint is disabled.",
  });
}
