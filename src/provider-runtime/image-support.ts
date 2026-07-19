const NATIVE_IMAGE_PROVIDERS = new Set(['codex', 'claude', 'kimi', 'opencode']);

export function providerSupportsImageInput(cli: string): boolean {
  return NATIVE_IMAGE_PROVIDERS.has(cli);
}
