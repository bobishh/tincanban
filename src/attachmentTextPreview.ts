const PREVIEW_BYTES = 32 * 1024

/** Bound browser text layout; the verified attachment remains complete for download. */
export function attachmentTextPreview(bytes: Uint8Array): { text: string; truncated: boolean } {
  const truncated = bytes.byteLength > PREVIEW_BYTES
  return { text: new TextDecoder().decode(bytes.subarray(0, PREVIEW_BYTES), { stream: truncated }), truncated }
}
