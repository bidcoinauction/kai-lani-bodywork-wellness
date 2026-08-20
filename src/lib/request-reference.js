export function publicRequestReference(data) {
  return data?.requestKey || data?.requestId || "";
}
