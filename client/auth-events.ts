// Broadcast only that identity changed; never send names, passwords or session tokens.
export function announceAuthChange() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("linli-auth");
  channel.postMessage("changed");
  channel.close();
}
export function watchAuthChange(refresh: () => void) {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel("linli-auth");
  channel.onmessage = (event) => {
    if (event.data === "changed") refresh();
  };
  return () => channel.close();
}
