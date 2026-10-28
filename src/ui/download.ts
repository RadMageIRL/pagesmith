/**
 * Hands bytes to the browser as a download. The browser decides the final path and de-duplicates
 * names, so an existing file is never overwritten silently.
 */
export function downloadBlob(bytes: Uint8Array, filename: string, type: string): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the download has had time to start; revoking synchronously cancels it in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
