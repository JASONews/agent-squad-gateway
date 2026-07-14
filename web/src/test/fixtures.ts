export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function gatewayErrorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}
