export async function copyText(value: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // iOS webviews may expose Clipboard API but deny it. Continue to the
      // selection-based fallback while the original user gesture is active.
    }
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.top = "0";
  document.body.appendChild(field);
  field.focus({ preventScroll: true });
  field.select();
  field.setSelectionRange(0, value.length);
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("ClipboardUnavailable");
}
