export default async function handler(req, res) {
  return res.status(501).json({
    error: "Not implemented",
    message: "Dashboard requires proper authentication. Not built yet.",
  });
}
