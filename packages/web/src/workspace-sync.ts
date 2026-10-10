/** Same-origin hints only. Receivers fetch the authorized cookie-backed view themselves. */
const channelName = "wildwood-workspace";
function openChannel() {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    return new BroadcastChannel(channelName);
  } catch {
    /* Polling still works where channel access is unavailable. */
  }
}
export function notifyWorkspace() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("wildwood:workspace"));
  const channel = openChannel();
  if (channel) {
    channel.postMessage("changed");
    channel.close();
  }
}
export function watchWorkspace(check: () => void) {
  window.addEventListener("wildwood:workspace", check);
  const channel = openChannel();
  if (channel) channel.onmessage = check;
  return () => {
    window.removeEventListener("wildwood:workspace", check);
    channel?.close();
  };
}
